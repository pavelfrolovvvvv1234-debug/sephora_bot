/**
 * Premium multi-step VPS/VDS purchase UI (type → tier → plans → card → OS / buy).
 */

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import type { SessionData } from "../../shared/types/session.js";
import prices from "../../helpers/prices.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import User, { Role } from "../../entities/User.js";
import VirtualDedicatedServer, { generatePassword, generateRandomName } from "../../entities/VirtualDedicatedServer.js";
import {
  assertVdsCatalogLength,
  VDS_INDEX_TIER,
  VDS_SHOP_PAGE_SIZE,
  type VpsShopTier,
} from "./vds-shop-config.js";
import { showTopupForMissingAmount } from "../../helpers/deposit-money.js";
import { DedicatedProvisioningService } from "../dedicated/DedicatedProvisioningService.js";
import { DedicatedOrderPaymentStatus } from "../../entities/DedicatedServerOrder.js";
import { getModeratorChatId } from "../../shared/moderator-chat.js";
import { DEDICATED_OS_KEYS } from "../dedicated/dedicated-shop-config.js";
import { getProxmoxTemplateMap, isProxmoxEnabled } from "../../app/config.js";
import ms from "../../lib/multims.js";
import {
  buildPremiumVpsReadyHtml,
  escapeHtml,
  getVpsCpuModelForRate as getVpsCpuModel,
  type PremiumVpsReadyPayload,
} from "./vps-onboarding-messages.js";

const TIER_ORDER: VpsShopTier[] = ["start", "standard", "performance", "enterprise"];

/** Remove inline keyboard from the message that triggered the callback (e.g. OS picker). */
async function stripCallbackMessageKeyboard(ctx: AppContext): Promise<void> {
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
}

/** Proxmox clone + wait + resize routinely exceeds 30s; ISP VMManager is usually faster. */
function vpsCreateVmRaceTimeoutMs(): number {
  return isProxmoxEnabled() ? 240_000 : 30_000;
}

const isUniqueVdsIdConflictError = (error: unknown): boolean => {
  const message = String((error as { message?: string })?.message ?? error ?? "");
  return (
    message.includes("UNIQUE constraint failed: vdslist.vdsId") ||
    message.includes("duplicate key value violates unique constraint") ||
    message.includes("vdslist_vdsid_key")
  );
};

function appendVpsShopBackOnly(kb: InlineKeyboard, ctx: AppContext, backData: string): void {
  kb.text(ctx.t("button-back"), backData).row();
}

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

const renderMultiline = (text: string): string => text.replace(/\\n/g, "\n");
const VPS_LOCATION_NL_ONLY_KEY = "nl-amsterdam";

function getAllowedVpsLocationKeys(_rate: { cpu?: number; ram?: number; ssd?: number }): string[] {
  return [VPS_LOCATION_NL_ONLY_KEY];
}

async function createVpsOrderTicket(
  ctx: AppContext,
  rateId: number,
  locationKey?: string,
  osKey?: string
): Promise<void> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  const pricesList = await prices();
  const rate = pricesList.virtual_vds?.[rateId];
  if (!rate) {
    await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  const dataSource = ctx.appDataSource ?? (await getAppDataSource());
  const usersRepo = dataSource.getRepository(User);
  const user = await usersRepo.findOneBy({ id: session.main.user.id });
  if (!user) {
    await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  const basePrice = session.other.vdsRate.bulletproof ? rate.price.bulletproof : rate.price.default;
  const price = await getPriceWithPrimeDiscount(dataSource, user.id, basePrice);
  if (user.balance < price) {
    await showTopupForMissingAmount(ctx, price - user.balance);
    return;
  }

  let deducted = false;
  try {
    user.balance -= price;
    await usersRepo.save(user);
    deducted = true;
    session.main.user.balance = user.balance;

    const provisioningService = new DedicatedProvisioningService(dataSource);
    const idempotencyKey = ctx.callbackQuery?.id
      ? `tgcb:${ctx.callbackQuery.id}`
      : `vps:${session.main.user.id}:${rateId}:${Date.now()}`;
    const category = session.other.vdsRate.bulletproof ? "bulletproof" : "standard";
    const locationLabel = locationKey ? ctx.t(`dedicated-location-${locationKey}` as any) : "N/A";
    const osLabel = osKey ? ctx.t(`dedicated-os-${osKey}` as any) : "N/A";

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
        productId: `vps-${rateId}`,
        productName: rate.name ?? `VPS #${rateId}`,
        category,
        cpuCores: Number(rate.cpu ?? 0) || null,
        ram: rate.ram != null ? String(rate.ram) : null,
        storageType: "SSD",
        storageSize: rate.ssd != null ? `${rate.ssd} GB` : null,
        uplinkSpeed: rate.network != null ? `${rate.network}` : null,
        locationKey: locationKey ?? null,
        locationLabel,
        osKey: osKey ?? null,
        osLabel,
        ddosProtection: session.other.vdsRate.bulletproof ? "enhanced" : "standard",
        deploymentNotes: "Temporary VPS/VDS flow via provisioning tickets (as dedicated).",
      },
    });

    const order = created.order;
    const ticket = created.ticket;

    const buyerText = renderMultiline(
      ctx.t("dedicated-provisioning-ticket-created", {
        ticketId: ticket.id,
        orderId: order.id,
        serviceName: escapeHtml(rate.name ?? `VPS #${rateId}`),
        location: escapeHtml(locationLabel),
        os: escapeHtml(osLabel),
      })
    );
    await ctx.reply(buyerText, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });

    if (!buyerIsStaff) {
      const moderators = await usersRepo.find({
        where: [{ role: Role.Admin }, { role: Role.Moderator }],
      });
      const staffText = renderMultiline(
        ctx.t("dedicated-provisioning-staff-notification", {
          ticketId: ticket.id,
          orderId: order.id,
          userId: user.id,
          amount: price,
          serviceName: rate.name ?? `VPS #${rateId}`,
          location: locationLabel,
          os: osLabel,
        })
      );
      const staffKeyboard = new InlineKeyboard()
        .text(ctx.t("button-open"), `prov_view_${ticket.id}`)
        .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);
      const recipientChatIds = new Set<number>();
      for (const mod of moderators) recipientChatIds.add(mod.telegramId);
      const moderatorChatId = getModeratorChatId();
      if (moderatorChatId) recipientChatIds.add(moderatorChatId);
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
    if (deducted) {
      try {
        user.balance += price;
        await usersRepo.save(user);
        session.main.user.balance = user.balance;
      } catch {
        // ignore rollback failure, original error is still returned below
      }
    }
    await ctx
      .reply(ctx.t("error-unknown", { error: error?.message || "Unknown error" }), { parse_mode: "HTML" })
      .catch(() => {});
  }
}

async function createVpsOrderDirect(
  ctx: AppContext,
  rateId: number,
  locationKey?: string,
  osKey?: string
): Promise<boolean> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  const pricesList = await prices();
  const rate = pricesList.virtual_vds?.[rateId];
  if (!rate) {
    await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
    return false;
  }
  if (!osKey) {
    await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
    return false;
  }

  const templateMap = getProxmoxTemplateMap();
  const osId = Number(templateMap[osKey] ?? 0);
  if (!Number.isFinite(osId) || osId <= 0) {
    await ctx.reply("Эта ОС пока не подключена для авто-развёртывания в Proxmox.", { parse_mode: "HTML" }).catch(() => {});
    return false;
  }

  const dataSource = ctx.appDataSource ?? (await getAppDataSource());
  const usersRepo = dataSource.getRepository(User);
  const vdsRepo = dataSource.getRepository(VirtualDedicatedServer);
  const user = await usersRepo.findOneBy({ id: session.main.user.id });
  if (!user) {
    await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
    return false;
  }

  const basePrice = session.other.vdsRate.bulletproof ? rate.price.bulletproof : rate.price.default;
  const price = await getPriceWithPrimeDiscount(dataSource, user.id, basePrice);
  if (user.balance < price) {
    await showTopupForMissingAmount(ctx, price - user.balance);
    // Already handled for the user; do not fall back to ticket flow,
    // otherwise the same top-up prompt can be sent twice.
    return true;
  }

  let deducted = false;
  const chatId = ctx.chat?.id;
  const waitMessage = chatId
    ? await ctx.reply(ctx.t("vds-provisioning-wait"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => undefined)
    : undefined;

  try {
    user.balance -= price;
    await usersRepo.save(user);
    deducted = true;
    session.main.user.balance = user.balance;

    const maxProvisionAttempts = 3;
    let savedVds: VirtualDedicatedServer | null = null;
    let savedIp = "0.0.0.0";
    let lastProvisionError: unknown;
    let lastVmName = "";
    let lastVmDisplayName = "";

    for (let attempt = 1; attempt <= maxProvisionAttempts; attempt++) {
      const generatedPassword = generatePassword(12);
      const vmName = generateRandomName(13);
      const comment = `UserID:${user.id},${rate.name},loc:${locationKey ?? "n/a"},os:${osKey},try:${attempt}`;
      const vmResult = await Promise.race([
        ctx.vmmanager.createVM(
          vmName,
          generatedPassword,
          rate.cpu,
          rate.ram,
          osId,
          comment,
          rate.ssd,
          1,
          rate.network,
          rate.network
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), vpsCreateVmRaceTimeoutMs())),
      ]);
      if (!vmResult) {
        lastProvisionError = new Error("createVM returned false");
        continue;
      }

      let vmInfo: any | undefined;
      for (let i = 0; i < 6; i++) {
        vmInfo = await ctx.vmmanager.getInfoVM(vmResult.id);
        if (vmInfo) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      let ipv4Addrs: { list: Array<{ ip_addr: string }> } | undefined;
      for (let i = 0; i < 20; i++) {
        ipv4Addrs = await ctx.vmmanager.getIpv4AddrVM(vmResult.id);
        const ipCandidate = ipv4Addrs?.list?.[0]?.ip_addr;
        if (ipCandidate && ipCandidate !== "0.0.0.0" && ipCandidate !== "127.0.0.1") break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const ip = ipv4Addrs?.list?.[0]?.ip_addr ?? "0.0.0.0";

      const vds = new VirtualDedicatedServer();
      vds.vdsId = vmResult.id;
      vds.login = "root";
      vds.password = generatedPassword;
      vds.ipv4Addr = ip;
      vds.cpuCount = rate.cpu;
      vds.networkSpeed = rate.network;
      vds.isBulletproof = session.other.vdsRate.bulletproof;
      vds.payDayAt = null;
      vds.ramSize = rate.ram;
      vds.diskSize = rate.ssd;
      vds.lastOsId = osId;
      vds.rateName = rate.name;
      vds.expireAt = new Date(Date.now() + ms("30d"));
      vds.targetUserId = user.id;
      vds.renewalPrice = price;
      vds.autoRenewEnabled = true;
      vds.adminBlocked = false;
      vds.managementLocked = false;
      vds.extraIpv4Count = 0;
      try {
        savedVds = await vdsRepo.save(vds);
        savedIp = ip;
        lastVmName = vmName;
        lastVmDisplayName = (vmInfo?.name && String(vmInfo.name).trim()) || vmName;
        break;
      } catch (error) {
        if (isUniqueVdsIdConflictError(error) && attempt < maxProvisionAttempts) {
          lastProvisionError = error;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }
        throw error;
      }
    }

    if (!savedVds) {
      const baseMessage = "Failed to save VPS after retrying VMID conflicts";
      const reason = String((lastProvisionError as { message?: string })?.message ?? "").trim();
      throw new Error(reason ? `${baseMessage}: ${reason}` : baseMessage);
    }

    const regionLabel = locationKey
      ? ctx.t(`dedicated-location-${locationKey}` as any)
      : ctx.t("vps-premium-region-auto");
    const osLabel = ctx.t(`dedicated-os-${osKey}` as any);
    const payload: PremiumVpsReadyPayload = {
      vmName: lastVmDisplayName || lastVmName || `vm-${savedVds.vdsId}`,
      vdsId: savedVds.vdsId,
      regionLabel,
      planName: rate.name ?? `VPS #${rateId}`,
      cpu: rate.cpu,
      ramGb: rate.ram,
      diskGb: rate.ssd,
      networkMbps: rate.network,
      cpuModel: getVpsCpuModel(rate as { cpuModel?: string }),
      osLabel,
      ipv4: savedIp,
      login: savedVds.login,
      password: savedVds.password,
    };
    const readyHtml = buildPremiumVpsReadyHtml(ctx, payload);
    if (waitMessage && chatId) {
      await ctx.api.deleteMessage(chatId, waitMessage.message_id).catch(() => {});
    }
    await ctx.reply(readyHtml, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {});
    return true;
  } catch (error: any) {
    if (waitMessage && chatId) {
      await ctx.api
        .editMessageText(chatId, waitMessage.message_id, ctx.t("vps-provisioning-failed"), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
    }
    if (deducted) {
      try {
        user.balance += price;
        await usersRepo.save(user);
        session.main.user.balance = user.balance;
      } catch {
        // ignore rollback failure
      }
    }
    await ctx
      .reply(ctx.t("error-unknown", { error: error?.message || "Unknown error" }), { parse_mode: "HTML" })
      .catch(() => {});
    // Do not fall back to ticket flow after a failed auto-provision:
    // it can double-charge users and creates the illusion of "manual provisioning" for VPS.
    return true;
  }
}

async function showVpsLocationPicker(ctx: AppContext, rateId: number): Promise<void> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  session.other.vdsRate.selectedRateId = rateId;
  const pricesList = await prices();
  const rate = pricesList.virtual_vds?.[rateId];
  if (!rate) {
    await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
    return;
  }
  const allowedLocationKeys = getAllowedVpsLocationKeys(rate);
  if (allowedLocationKeys.length === 1) {
    await showVpsOsPicker(ctx, rateId, allowedLocationKeys[0]!);
    return;
  }
  const kb = new InlineKeyboard();
  for (const key of allowedLocationKeys) {
    kb.text(ctx.t(`dedicated-location-${key}` as any), `vsh:loc:${key}`).row();
  }
  kb.text(ctx.t("button-back"), `vsh:card:${rateId}`).row();
  await ctx.editMessageText(ctx.t("dedicated-location-select-title"), {
    parse_mode: "HTML",
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

async function showVpsOsPicker(ctx: AppContext, rateId: number, locationKey: string): Promise<void> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  if (!session.other.dedicatedOrder) {
    session.other.dedicatedOrder = { step: "idle", requirements: undefined };
  }
  session.other.dedicatedOrder.selectedLocationKey = locationKey;
  session.other.vdsRate.selectedRateId = rateId;

  const kb = new InlineKeyboard();
  for (const key of DEDICATED_OS_KEYS) {
    kb.text(ctx.t(`dedicated-os-${key}` as any), `vsh:os:${key}`).row();
  }
  kb.text(ctx.t("button-back"), `vsh:loc_back:${rateId}`).row();
  await ctx.editMessageText(ctx.t("dedicated-os-select-title"), {
    parse_mode: "HTML",
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

function ensureVpsShopSession(session: SessionData): void {
  if (!session.other.vdsRate) {
    session.other.vdsRate = {
      bulletproof: false,
      selectedRateId: -1,
      selectedOs: -1,
      shopTier: null,
      shopListPage: 0,
    };
  }
  if (session.other.vdsRate.shopListPage == null) session.other.vdsRate.shopListPage = 0;
}

export function getVdsIndicesForTier(list: unknown[], tier: VpsShopTier): number[] {
  const out: number[] = [];
  list.forEach((_, id) => {
    if (VDS_INDEX_TIER[id] === tier) out.push(id);
  });
  return out;
}

function formatUsdShort(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

async function compactPlanButtonLabel(
  ctx: AppContext,
  rate: { name: string; cpu: number; ram: number; ssd: number },
  basePrice: number
): Promise<string> {
  const ds = ctx.appDataSource ?? (await getAppDataSource());
  const session = await ctx.session;
  const price = await getPriceWithPrimeDiscount(ds, session.main.user.id, basePrice);
  const p = formatUsdShort(price);
  return `${rate.cpu}C / ${rate.ram}GB / ${rate.ssd}GB | ${p}$`;
}

/** Step 1: VPS type (uses grammY vdsTypeMenu). */
export async function showVpsShopStep1(ctx: AppContext): Promise<void> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  session.other.vdsRate.shopTier = null;
  session.other.vdsRate.shopListPage = 0;
  session.other.vdsRate.selectedRateId = -1;
  session.other.vdsRate.selectedOs = -1;

  const { vdsTypeMenu } = await import("../../helpers/services-menu.js");
  await ctx.editMessageText(ctx.t("vds-shop-step1-text"), {
    parse_mode: "HTML",
    reply_markup: vdsTypeMenu,
    link_preview_options: { is_disabled: true },
  });
}

/** Открыть список тарифов VPS из главного меню / команды (есть callback или только текстовое сообщение). */
export async function openVpsTariffSelection(ctx: AppContext): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  const { createInitialOtherSession } = await import("../../shared/session-initial.js");
  const session = await ctx.session;
  if (!session.other) (session as any).other = createInitialOtherSession();
  session.other.vdsRate.bulletproof = false;
  session.other.vdsRate.shopTier = null;
  session.other.vdsRate.shopListPage = 0;
  session.other.vdsRate.selectedRateId = -1;
  session.other.vdsRate.selectedOs = -1;
  await showVpsShopStep2Tier(ctx);
}

/** Step 2: tier */
export async function showVpsShopStep2Tier(ctx: AppContext): Promise<void> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  session.other.vdsRate.shopTier = null;
  session.other.vdsRate.shopListPage = 0;
  await showVpsShopStep3List(ctx, 0);
}

/** Step 3: plan list */
export async function showVpsShopStep3List(ctx: AppContext, page?: number): Promise<void> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  const vr = session.other.vdsRate;
  const tier = vr.shopTier;
  const p = page ?? vr.shopListPage ?? 0;
  vr.shopListPage = p;

  const pricesList = await prices();
  const list = pricesList.virtual_vds ?? [];
  assertVdsCatalogLength(list.length);

  const ids =
    tier == null ? list.map((_, idx) => idx) : getVdsIndicesForTier(list, tier);
  const totalPages = Math.max(1, Math.ceil(ids.length / VDS_SHOP_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, p), totalPages - 1);
  vr.shopListPage = safePage;
  const start = safePage * VDS_SHOP_PAGE_SIZE;
  const slice = ids.slice(start, start + VDS_SHOP_PAGE_SIZE);

  const header = vr.bulletproof
    ? `<b>${ctx.t("vds-shop-bulletproof-list-header")}</b>`
    : `<b>🖥 ${ctx.t("vds-shop-type-standard")}</b>`;

  let body = `${header}\n\n${ctx.t("vds-shop-step3-prompt")}`;
  if (ids.length > VDS_SHOP_PAGE_SIZE) {
    body += `\n\n${ctx.t("vds-shop-list-page", { current: safePage + 1, total: totalPages })}`;
  }

  const kb = new InlineKeyboard();
  for (const id of slice) {
    const rate = list[id]!;
    const base = vr.bulletproof ? rate.price.bulletproof : rate.price.default;
    const label = await compactPlanButtonLabel(ctx, rate, base);
    kb.text(label, `vsh:sel:${id}`).row();
  }

  if (totalPages > 1) {
    const prev = safePage <= 0 ? totalPages - 1 : safePage - 1;
    const next = safePage >= totalPages - 1 ? 0 : safePage + 1;
    kb.text(ctx.t("vds-shop-page-prev"), `vsh:page:${prev}`)
      .text(ctx.t("vds-shop-page-next"), `vsh:page:${next}`)
      .row();
  }

  appendVpsShopBackOnly(kb, ctx, "vsh:back:services");

  const opts = {
    parse_mode: "HTML" as const,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(body, opts);
  } else {
    await ctx.reply(body, opts);
  }
}

/** Step 4: compact card */
export async function showVpsShopStep4Card(ctx: AppContext, rateId: number): Promise<void> {
  const session = await ctx.session;
  ensureVpsShopSession(session);
  const pricesList = await prices();
  const rate = pricesList.virtual_vds?.[rateId];
  if (!rate) {
    await ctx.answerCallbackQuery({ text: ctx.t("error-unknown", { error: "?" }).slice(0, 200), show_alert: true }).catch(() => {});
    return;
  }

  const vr = session.other.vdsRate;
  vr.selectedRateId = rateId;
  const basePrice = vr.bulletproof ? rate.price.bulletproof : rate.price.default;
  const dataSource = ctx.appDataSource ?? (await getAppDataSource());
  const price = await getPriceWithPrimeDiscount(dataSource, session.main.user.id, basePrice);

  const text = ctx.t("vds-shop-card", {
    title: rate.name,
    cpu: rate.cpu,
    ram: rate.ram,
    storage: rate.ssd,
    network: rate.network,
    price,
  });

  const kb = new InlineKeyboard()
    .text(ctx.t("vds-shop-order"), `vsh:ord:${rateId}`)
    .row()
    .text(ctx.t("vds-shop-details"), `vsh:det:${rateId}`)
    .row();
  appendVpsShopBackOnly(kb, ctx, `vsh:back:list`);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

export async function showVpsShopFullDetails(ctx: AppContext, rateId: number): Promise<void> {
  const session = await ctx.session;
  const pricesList = await prices();
  const rate = pricesList.virtual_vds?.[rateId];
  if (!rate) return;

  const vr = session.other.vdsRate;
  const basePrice = vr.bulletproof ? rate.price.bulletproof : rate.price.default;
  const dataSource = ctx.appDataSource ?? (await getAppDataSource());
  const price = await getPriceWithPrimeDiscount(dataSource, session.main.user.id, basePrice);

  const text = ctx.t("vds-rate-full-view", {
    rateName: rate.name,
    price,
    cpuModel: getVpsCpuModel(rate as { cpuModel?: string }),
    ram: rate.ram,
    disk: rate.ssd,
    cpu: rate.cpu,
    network: rate.network,
  });

  const kb = new InlineKeyboard();
  appendVpsShopBackOnly(kb, ctx, `vsh:card:${rateId}`);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

export function registerVpsShopHandlers(bot: Bot<AppContext>): void {
  bot.callbackQuery(/^vsh:tier:(start|standard|performance|enterprise)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const tier = ctx.match![1] as VpsShopTier;
    const session = await ctx.session;
    ensureVpsShopSession(session);
    session.other.vdsRate.shopTier = tier;
    session.other.vdsRate.shopListPage = 0;
    await showVpsShopStep3List(ctx, 0);
  });

  bot.callbackQuery(/^vsh:page:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const page = Number.parseInt(ctx.match![1]!, 10);
    const session = await ctx.session;
    ensureVpsShopSession(session);
    session.other.vdsRate.shopListPage = page;
    await showVpsShopStep3List(ctx, page);
  });

  bot.callbackQuery(/^vsh:sel:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = Number.parseInt(ctx.match![1]!, 10);
    await showVpsShopStep4Card(ctx, id);
  });

  bot.callbackQuery(/^vsh:ord:(\d+)$/, async (ctx) => {
    const id = Number.parseInt(ctx.match![1]!, 10);
    await ctx.answerCallbackQuery().catch(() => {});
    await showVpsLocationPicker(ctx, id);
  });

  bot.callbackQuery(/^vsh:loc:([a-z0-9-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const locationKey = ctx.match![1]!;
    const session = await ctx.session;
    const rateId = session.other.vdsRate.selectedRateId;
    if (rateId < 0) {
      await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    const pricesList = await prices();
    const rate = pricesList.virtual_vds?.[rateId];
    if (!rate) {
      await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    const allowedLocationKeys = getAllowedVpsLocationKeys(rate);
    if (!allowedLocationKeys.includes(locationKey)) {
      await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    await showVpsOsPicker(ctx, rateId, locationKey);
  });

  bot.callbackQuery(/^vsh:loc_back:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const rateId = Number.parseInt(ctx.match![1]!, 10);
    await showVpsLocationPicker(ctx, rateId);
  });

  bot.callbackQuery(/^vsh:os:([a-z0-9-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const osKey = ctx.match![1]!;
    const session = await ctx.session;
    const rateId = session.other.vdsRate.selectedRateId;
    const locationKey = session.other.dedicatedOrder?.selectedLocationKey;
    if (rateId < 0 || !locationKey) {
      await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    await stripCallbackMessageKeyboard(ctx as AppContext);
    if (isProxmoxEnabled()) {
      await createVpsOrderDirect(ctx, rateId, locationKey, osKey);
      return;
    }
    await createVpsOrderTicket(ctx, rateId, locationKey, osKey);
  });

  bot.callbackQuery(/^vsh:det:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = Number.parseInt(ctx.match![1]!, 10);
    await showVpsShopFullDetails(ctx, id);
  });

  bot.callbackQuery(/^vsh:card:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = Number.parseInt(ctx.match![1]!, 10);
    await showVpsShopStep4Card(ctx, id);
  });

  bot.callbackQuery("vsh:back:type", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const { getWelcomeMainMenu } = await import("../../ui/menus/main-menu-registry.js");
    await ctx.editMessageText(ctx.t("welcome", { balance: session.main.user.balance }), {
      parse_mode: "HTML",
      reply_markup: getWelcomeMainMenu(),
    });
  });

  bot.callbackQuery("vsh:back:tier", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const { getWelcomeMainMenu } = await import("../../ui/menus/main-menu-registry.js");
    await ctx.editMessageText(ctx.t("welcome", { balance: session.main.user.balance }), {
      parse_mode: "HTML",
      reply_markup: getWelcomeMainMenu(),
    });
  });

  bot.callbackQuery("vsh:back:services", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const { getWelcomeMainMenu } = await import("../../ui/menus/main-menu-registry.js");
    await ctx.editMessageText(ctx.t("welcome", { balance: session.main.user.balance }), {
      parse_mode: "HTML",
      reply_markup: getWelcomeMainMenu(),
    });
  });

  bot.callbackQuery("vsh:back:list", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    ensureVpsShopSession(session);
    await showVpsShopStep3List(ctx, session.other.vdsRate.shopListPage ?? 0);
  });

}
