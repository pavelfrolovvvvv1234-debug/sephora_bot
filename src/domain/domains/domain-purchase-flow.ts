/**
 * Domain purchase shop: category screens, paginated "all TLDs", TLD confirm, callbacks.
 */

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import prices from "../../helpers/prices.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import User from "../../entities/User.js";
import Domain from "../../entities/Domain.js";
import { showTopupForMissingAmount } from "../../helpers/deposit-money.js";
import { createInitialOtherSession } from "../../shared/session-initial.js";
import {
  DOMAIN_SHOP_CATEGORY_TLDS,
  DOMAIN_SHOP_PAGE_SIZE,
  type DomainShopCategory,
  suffixToZone,
  zoneToCallbackSuffix,
} from "./domain-purchase-config.js";

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

async function loadDomainZones(): Promise<Record<string, { price: number }>> {
  const list = await prices();
  return list.domains as Record<string, { price: number }>;
}

export async function buildDomainsPurchaseIntroHtml(ctx: AppContext): Promise<string> {
  const zones = await loadDomainZones();
  const minRaw = Math.min(...Object.values(zones).map((z) => z.price));
  return ctx.t("domains-purchase-screen", { minPrice: minRaw });
}

function filterZonesInPrice(zones: string[], catalog: Record<string, { price: number }>): string[] {
  return zones.filter((z) => catalog[z] != null);
}

function allZonesSorted(catalog: Record<string, { price: number }>): string[] {
  return Object.keys(catalog).sort((a, b) => a.localeCompare(b));
}

export function getZonesForCategory(
  category: DomainShopCategory,
  catalog: Record<string, { price: number }>
): string[] {
  if (category === "all") {
    return allZonesSorted(catalog);
  }
  return filterZonesInPrice(DOMAIN_SHOP_CATEGORY_TLDS[category], catalog);
}

async function displayPriceForZone(ctx: AppContext, basePrice: number): Promise<number> {
  const ds = ctx.appDataSource ?? (await getAppDataSource());
  const session = await ctx.session;
  return getPriceWithPrimeDiscount(ds, session.main.user.id, basePrice);
}

export async function showDomainShopHome(ctx: AppContext): Promise<void> {
  const text = await buildDomainsPurchaseIntroHtml(ctx);
  const { domainsMenu } = await import("../../helpers/services-menu.js");
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: domainsMenu,
    link_preview_options: { is_disabled: true },
  });
}

export async function showDomainCategoryTlds(ctx: AppContext, category: DomainShopCategory): Promise<void> {
  const session = await ctx.session;
  if (!session.other) (session as any).other = createInitialOtherSession();

  session.other.domains.shopCategory = category;
  if (category !== "all") {
    session.other.domains.shopAllPage = 0;
  } else {
    const p = session.other.domains.shopAllPage;
    if (p == null || p < 0) {
      session.other.domains.shopAllPage = 0;
    }
  }

  const catalog = await loadDomainZones();
  const zones = getZonesForCategory(category, catalog);
  const page = session.other.domains.shopAllPage ?? 0;
  const text = buildTldListMessage(ctx, category, zones, page);
  const kb = await buildTldListKeyboard(ctx, category, zones, page, catalog);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

function buildTldListMessage(
  ctx: AppContext,
  category: DomainShopCategory,
  allZonesInCat: string[],
  page: number
): string {
  const titleKey = `domain-shop-list-title-${category}` as const;
  let extra = "";
  if (category === "all" && allZonesInCat.length > DOMAIN_SHOP_PAGE_SIZE) {
    const totalPages = Math.max(1, Math.ceil(allZonesInCat.length / DOMAIN_SHOP_PAGE_SIZE));
    const humanPage = page + 1;
    extra = `\n\n${ctx.t("domain-shop-list-page", { current: humanPage, total: totalPages })}`;
  }
  return `${ctx.t(titleKey)}${extra}`;
}

async function buildTldListKeyboard(
  ctx: AppContext,
  category: DomainShopCategory,
  allZonesInCat: string[],
  page: number,
  catalog: Record<string, { price: number }>
): Promise<InlineKeyboard> {
  const kb = new InlineKeyboard();
  let slice = allZonesInCat;
  if (category === "all") {
    const start = page * DOMAIN_SHOP_PAGE_SIZE;
    slice = allZonesInCat.slice(start, start + DOMAIN_SHOP_PAGE_SIZE);
  }

  for (const zone of slice) {
    const base = catalog[zone]?.price ?? 0;
    const displayPrice = await displayPriceForZone(ctx, base);
    const label = `${zone} — ${displayPrice}$`;
    kb.text(label, `domz:${zoneToCallbackSuffix(zone)}`).row();
  }

  if (category === "all") {
    const totalPages = Math.ceil(allZonesInCat.length / DOMAIN_SHOP_PAGE_SIZE) || 1;
    if (totalPages > 1) {
      const prev = page <= 0 ? totalPages - 1 : page - 1;
      const next = page >= totalPages - 1 ? 0 : page + 1;
      kb.text(ctx.t("domain-shop-page-prev"), `domall:${prev}`)
        .text(ctx.t("domain-shop-page-next"), `domall:${next}`)
        .row();
    }
  }

  kb.text(ctx.t("prime-discount-domains"), "domshop:prime").row();
  kb.text(ctx.t("button-back"), "domshop:home").row();
  return kb;
}

export async function showDomainTldConfirm(ctx: AppContext, zone: string): Promise<void> {
  const catalog = await loadDomainZones();
  if (!catalog[zone]) {
    await ctx
      .answerCallbackQuery({
        text: ctx.t("error-unknown", { error: "TLD" }).slice(0, 200),
        show_alert: true,
      })
      .catch(() => {});
    return;
  }
  const session = await ctx.session;
  if (!session.other) (session as any).other = createInitialOtherSession();
  session.other.domains.shopConfirmZone = zone;

  const base = catalog[zone].price;
  const displayPrice = await displayPriceForZone(ctx, base);
  const text = ctx.t("domain-shop-confirm", { zone, price: displayPrice });

  const kb = new InlineKeyboard()
    .text(ctx.t("domain-shop-register"), `domconf:reg:${zoneToCallbackSuffix(zone)}`)
    .row()
    .text(ctx.t("domain-shop-my-domains"), "domconf:my")
    .row()
    .text(ctx.t("button-back"), "domconf:back");

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function showMyDomainsFromShop(ctx: AppContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const session = await ctx.session;
  const ds = ctx.appDataSource ?? (await getAppDataSource());
  const userId = session.main.user.id;
  const repo = ds.getRepository(Domain);
  const list = await repo.find({
    where: { userId },
    order: { createdAt: "DESC" },
    take: 20,
  });

  let body: string;
  if (list.length === 0) {
    body = ctx.t("domain-shop-my-empty");
  } else {
    body = list.map((d) => `• ${escapeHtml(d.domain)}`).join("\n");
  }
  const text = `${ctx.t("domain-shop-my-title")}\n\n${body}`;

  const kb = new InlineKeyboard().text(ctx.t("button-back"), "dommy:back");
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

async function startRegisterForZone(ctx: AppContext, zone: string): Promise<void> {
  const catalog = await loadDomainZones();
  if (!catalog[zone]) {
    await ctx
      .answerCallbackQuery({
        text: ctx.t("error-unknown", { error: "TLD" }).slice(0, 200),
        show_alert: true,
      })
      .catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const session = await ctx.session;
  if (!session.other) (session as any).other = createInitialOtherSession();

  const ds = ctx.appDataSource ?? (await getAppDataSource());
  const base = catalog[zone].price;
  const priceForCheck = await getPriceWithPrimeDiscount(ds, session.main.user.id, base);
  if (session.main.user.balance < priceForCheck) {
    await showTopupForMissingAmount(ctx, priceForCheck - session.main.user.balance);
    return;
  }
  session.other.domains.pendingZone = zone;
  await ctx.reply(ctx.t("domain-question", { zoneName: zone }), {
    reply_markup: new InlineKeyboard().text(ctx.t("button-cancel"), "domain-register-cancel"),
    parse_mode: "HTML",
  });
}

export function registerDomainPurchaseFlow(bot: Bot<AppContext>): void {
  bot.callbackQuery(/^domall:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const page = Number.parseInt(ctx.match![1]!, 10);
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    session.other.domains.shopCategory = "all";
    session.other.domains.shopAllPage = Number.isFinite(page) ? page : 0;
    await showDomainCategoryTlds(ctx, "all");
  });

  bot.callbackQuery(/^domz:([a-z0-9]+)$/, async (ctx) => {
    const zone = suffixToZone(ctx.match![1]!);
    const catalog = await loadDomainZones();
    if (!catalog[zone]) {
      await ctx
        .answerCallbackQuery({
          text: ctx.t("error-unknown", { error: "TLD" }).slice(0, 200),
          show_alert: true,
        })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await showDomainTldConfirm(ctx, zone);
  });

  bot.callbackQuery(/^domconf:reg:([a-z0-9]+)$/, async (ctx) => {
    const zone = suffixToZone(ctx.match![1]!);
    await startRegisterForZone(ctx, zone);
  });

  bot.callbackQuery("domconf:my", async (ctx) => {
    await showMyDomainsFromShop(ctx);
  });

  bot.callbackQuery("domconf:back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    const cat = session.other.domains.shopCategory ?? "popular";
    await showDomainCategoryTlds(ctx, cat as DomainShopCategory);
  });

  bot.callbackQuery("domshop:home", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    await showDomainShopHome(ctx);
  });

  bot.callbackQuery("domshop:prime", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      const { getDomainsListWithPrimeScreen } = await import("../../ui/menus/amper-domains-menu.js");
      const { fullText, keyboard } = await getDomainsListWithPrimeScreen(ctx, {
        backCallback: "prime-back-to-domain-shop-category",
      });
      await ctx.editMessageText(fullText, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } catch (e: any) {
      await ctx
        .editMessageText(ctx.t("error-unknown", { error: e?.message || "Error" }))
        .catch(() => {});
    }
  });

  bot.callbackQuery("dommy:back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const zone = session.other?.domains?.shopConfirmZone;
    if (zone) {
      const catalog = await loadDomainZones();
      if (catalog[zone]) {
        await showDomainTldConfirm(ctx, zone);
        return;
      }
    }
    await showDomainShopHome(ctx);
  });
}
