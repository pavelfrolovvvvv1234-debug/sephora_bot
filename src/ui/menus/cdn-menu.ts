/**
 * CDN / Site proxy menu and conversation.
 * Integrates with proxy-service Bot API (create proxy, list proxies).
 *
 * @module ui/menus/cdn-menu
 */

import { InlineKeyboard } from "grammy";
import type { AppContext, AppConversation } from "../../shared/types/context";
import { getCdnAutoTargetUrl, isCdnEnabled } from "../../app/config";
import {
  cdnGetPrice,
  cdnCreateProxy,
  cdnListProxies,
  cdnDeleteProxy,
  cdnRenewProxy,
  cdnRetrySsl,
  cdnToggleAutoRenew,
  type CdnProxyItem,
} from "../../infrastructure/cdn/CdnClient";
import { getCdnPlan, parseCdnPlanId, type CdnPlanId } from "../../infrastructure/cdn/cdn-plans";
import { showTopupForMissingAmount } from "../../helpers/deposit-money";
import { getAppDataSource } from "../../database";
import User from "../../entities/User";
import { createInitialOtherSession } from "../../shared/session-initial";
import CdnProxyService from "../../entities/CdnProxyService";
import CdnProxyAudit from "../../entities/CdnProxyAudit";
import { ensureSessionUser } from "../../shared/utils/session-user.js";

const DOMAIN_REGEX =
  /^(?!https?:\/\/)(?!www\.$)(?!.*\/$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function cdnPlanIdOrDefault(session: { other?: { cdn?: { planId?: string } } }): CdnPlanId {
  const id = session?.other?.cdn?.planId;
  return id === "bulletproof" || id === "bundle" || id === "standard" ? id : "standard";
}

/** Tariff from session, or legacy single price from CDN API. */
async function resolveCdnChargeUsd(session: any): Promise<number> {
  // Always trust selected plan first to avoid stale session.price values.
  const planId = cdnPlanIdOrDefault(session);
  const planPrice = Number(getCdnPlan(planId)?.priceUsd ?? Number.NaN);
  if (Number.isFinite(planPrice) && planPrice > 0) return planPrice;

  const p = session?.other?.cdn?.price;
  const parsedPrice =
    typeof p === "number" ? p : typeof p === "string" ? Number.parseFloat(p) : Number.NaN;
  if (Number.isFinite(parsedPrice) && parsedPrice > 0) return parsedPrice;

  return cdnGetPrice();
}

function isValidDomain(name: string): boolean {
  return DOMAIN_REGEX.test(name.trim());
}

function isValidTargetUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeHost(value: string): boolean {
  const hostLike = /^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?(\/.*)?$/;
  return hostLike.test(value.trim());
}

function normalizeTargetUrlInput(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return isValidTargetUrl(raw) ? raw : null;
  }
  if (!looksLikeHost(raw)) return null;
  const normalized = `https://${raw}`;
  return isValidTargetUrl(normalized) ? normalized : null;
}

function normalizeDomainInput(input: string): string {
  return input.trim().toLowerCase();
}

function isSelfTarget(domainName: string, targetUrl: string): boolean {
  try {
    const domainHost = normalizeDomainInput(domainName);
    const targetHost = new URL(targetUrl).hostname.trim().toLowerCase();
    return domainHost === targetHost;
  } catch {
    return false;
  }
}

function ensureCdnSession(session: any): void {
  if (!session) return;
  if (!session.other) (session as any).other = createInitialOtherSession();
  if (!session.other!.cdn) session.other!.cdn = { step: "idle" };
}

function buildTargetInputKeyboard(ctx: AppContext): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t("button-cdn-target-auto"), "cdn_target_auto")
    .row()
    .text(ctx.t("button-cdn-target-help"), "cdn_target_help");
}

function buildCdnTariffsKeyboard(ctx: AppContext): InlineKeyboard {
  const kb = new InlineKeyboard();
  const std = getCdnPlan("standard");
  const prot = getCdnPlan("bulletproof");
  const bndl = getCdnPlan("bundle");
  kb.text(ctx.t("button-cdn-pick-standard", { price: std.priceUsd }), "cdn_card:standard")
    .row()
    .text(ctx.t("button-cdn-pick-protected", { price: prot.priceUsd }), "cdn_card:bulletproof")
    .row()
    .text(ctx.t("button-cdn-pick-bundle", { price: bndl.priceUsd }), "cdn_card:bundle")
    .row()
    .text(ctx.t("button-cdn-prime-row"), "cdn_prime_row")
    .row()
    .text(ctx.t("button-back"), "cdn_exit_services")
    .row();
  return kb;
}

function buildCdnPlanCardKeyboard(ctx: AppContext, planId: CdnPlanId): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t("button-cdn-connect"), `cdn_plan:${planId}`)
    .row()
    .text(ctx.t("button-cdn-details"), `cdn_detail:${planId}`)
    .row()
    .text(ctx.t("button-back"), "cdn_nav:tariffs")
    .row();
}

function buildCdnPlanDetailKeyboard(ctx: AppContext, planId: CdnPlanId): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t("button-back"), `cdn_card:${planId}`).row();
}

function cdnCardBodyKey(planId: CdnPlanId): string {
  if (planId === "standard") return "cdn-card-standard-body";
  if (planId === "bulletproof") return "cdn-card-protected-body";
  return "cdn-card-bundle-body";
}

function cdnDetailBodyKey(planId: CdnPlanId): string {
  if (planId === "standard") return "cdn-detail-standard-body";
  if (planId === "bulletproof") return "cdn-detail-protected-body";
  return "cdn-detail-bundle-body";
}

/** Step 1 — CDN hub (purchase menu). */
export async function showCdnMainHub(ctx: AppContext): Promise<void> {
  const session = (await ctx.session) as any;
  if (session?.other) {
    ensureCdnSession(session);
    const fm = session.other.cdn?.fromManage === true;
    session.other.cdn = { step: "idle", fromManage: fm };
  }
  const text = ctx.t("cdn-main-screen");
  const kb = new InlineKeyboard()
    .text(ctx.t("button-cdn-plans"), "cdn_nav:tariffs")
    .row()
    .text(ctx.t("button-cdn-proxy-ip"), "cdn_nav:proxy")
    .row()
    .text(ctx.t("button-back"), "cdn_exit_services")
    .row();
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  }
}

/** Step 2 — tariff list + Prime. */
export async function showCdnTariffsScreen(ctx: AppContext, opts?: { useReply?: boolean }): Promise<void> {
  const session = (await ctx.session) as any;
  if (session?.other) {
    ensureCdnSession(session);
    session.other.cdn.step = "plan";
    session.other.cdn.telegramId = ctx.from?.id ?? ctx.loadedUser?.telegramId ?? session.other.cdn.telegramId;
  }
  const text = ctx.t("cdn-tariffs-screen");
  const kb = buildCdnTariffsKeyboard(ctx);
  const payload = {
    parse_mode: "HTML" as const,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };
  if (opts?.useReply) {
    await ctx.reply(text, payload);
    return;
  }
  try {
    await ctx.editMessageText(text, payload);
  } catch {
    await ctx.reply(text, payload);
  }
}

/** Step 3 — compact product card. */
export async function showCdnPlanCardScreen(ctx: AppContext, planId: CdnPlanId): Promise<void> {
  const plan = getCdnPlan(planId);
  const text = ctx.t(cdnCardBodyKey(planId), { price: plan.priceUsd });
  const payload = {
    parse_mode: "HTML" as const,
    reply_markup: buildCdnPlanCardKeyboard(ctx, planId),
    link_preview_options: { is_disabled: true },
  };
  try {
    await ctx.editMessageText(text, payload);
  } catch {
    await ctx.reply(text, payload);
  }
}

/** Plan long description (Details). */
export async function showCdnPlanDetailScreen(ctx: AppContext, planId: CdnPlanId): Promise<void> {
  const plan = getCdnPlan(planId);
  const text = ctx.t(cdnDetailBodyKey(planId), { price: plan.priceUsd });
  const payload = {
    parse_mode: "HTML" as const,
    reply_markup: buildCdnPlanDetailKeyboard(ctx, planId),
    link_preview_options: { is_disabled: true },
  };
  try {
    await ctx.editMessageText(text, payload);
  } catch {
    await ctx.reply(text, payload);
  }
}

/** Proxies / IP hub before purchase branch. */
export async function showCdnProxyHubScreen(ctx: AppContext): Promise<void> {
  const text = ctx.t("cdn-proxy-hub-screen");
  const kb = new InlineKeyboard()
    .text(ctx.t("button-cdn-add-proxy"), "cdn_nav:tariffs")
    .row()
    .text(ctx.t("button-back"), "cdn_nav:main")
    .row();
  const payload = {
    parse_mode: "HTML" as const,
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  };
  try {
    await ctx.editMessageText(text, payload);
  } catch {
    await ctx.reply(text, payload);
  }
}

async function askTargetUrl(ctx: AppContext): Promise<void> {
  await ctx.reply(ctx.t("cdn-enter-target-friendly"), {
    parse_mode: "HTML",
    reply_markup: buildTargetInputKeyboard(ctx),
  });
}

/** Безопасный вызов перевода: если ctx.t недоступен (например при рендере меню), возвращаем fallback. */
function safeT(ctx: AppContext, key: string, vars?: Record<string, string | number>): string {
  if (typeof (ctx as any).t === "function") {
    return (ctx as any).t(key, vars);
  }
  const ru: Record<string, string> = {
    "button-cdn-add-proxy": "➕ Добавить прокси",
    "button-cdn-my-proxies": "Мои прокси",
    "button-back": "⬅️ Назад",
    "cdn-not-configured": "Услуга CDN пока не подключена.",
    "cdn-error": "Ошибка CDN: " + (vars?.error ?? ""),
    "cdn-my-proxies-empty": "",
    "cdn-my-proxies-list": "Ваши прокси",
    "cdn-proxy-item": `${vars?.domain ?? ""} → ${vars?.target ?? ""} (${vars?.status ?? ""})`,
    "manage-services-header": "💼 Управление услугами",
    "menu-service-for-buy-choose": "🚀 Выберите услугу",
  };
  return ru[key] ?? key;
}

/**
 * Conversation: add CDN proxy — domain → target URL → confirm → pay → create.
 */
export async function cdnAddProxyConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  let session = (await ctx.session) as any;
  if (!session) {
    await ctx.reply(ctx.t("cdn-error", { error: "Session not ready. Try again." }), {
      parse_mode: "HTML",
    });
    return;
  }
  await ensureSessionUser(ctx);
  ensureCdnSession(session);
  const telegramId = ctx.from?.id ?? ctx.loadedUser?.telegramId;
  if (telegramId == null) {
    await ctx.reply(ctx.t("cdn-error", { error: "User not found" }), { parse_mode: "HTML" });
    return;
  }
  session.other.cdn.telegramId = telegramId;

  await ctx.reply(ctx.t("cdn-enter-domain"), { parse_mode: "HTML" });

  const domainCtx = await conversation.waitFor("message:text");
  session = (await (domainCtx as any).session) as any;
  ensureCdnSession(session);
  const domainName = normalizeDomainInput(domainCtx.message.text ?? "");

  if (!domainName) {
    await ctx.reply(ctx.t("cdn-invalid-domain"));
    return;
  }
  if (!isValidDomain(domainName)) {
    await ctx.reply(ctx.t("cdn-invalid-domain"));
    return;
  }

  session.other.cdn.domainName = domainName;
  session.other.cdn.planId = "standard";
  session.other.cdn.price = getCdnPlan("standard").priceUsd;
  await askTargetUrl(ctx);

  const targetCtx = await conversation.waitFor("message:text");
  session = (await (targetCtx as any).session) as any;
  ensureCdnSession(session);
  const targetUrl = targetCtx.message.text?.trim() ?? "";

    const normalized = normalizeTargetUrlInput(targetUrl);
    if (!normalized) {
    await ctx.reply(ctx.t("cdn-invalid-url"));
    return;
  }

  if (isSelfTarget(session.other.cdn.domainName ?? "", normalized)) {
    await ctx.reply(
      ctx.t("cdn-error", { error: "Origin URL must be different from CDN domain" }),
      { parse_mode: "HTML" }
    );
    return;
  }

  session.other.cdn.targetUrl = normalized;

  const keyboard = new InlineKeyboard()
    .text(ctx.t("button-cdn-confirm"), "cdn_confirm")
    .text(ctx.t("button-cdn-cancel"), "cdn_cancel");

  await ctx.reply(
    ctx.t("cdn-confirm", {
      domainName: session.other.cdn.domainName,
      targetUrl: session.other.cdn.targetUrl!,
      price: session.other.cdn.price!,
      planName: ctx.t(getCdnPlan(cdnPlanIdOrDefault(session)).labelKey),
    }),
    { parse_mode: "HTML", reply_markup: keyboard }
  );

  const confirmCtx = await conversation.waitForCallbackQuery(/^cdn_(confirm|cancel)$/);
  session = (await (confirmCtx as any).session) as any;
  ensureCdnSession(session);
  if (!confirmCtx.callbackQuery?.data) {
    return;
  }
  if (confirmCtx.callbackQuery.data === "cdn_cancel") {
    await confirmCtx.answerCallbackQuery();
    await confirmCtx.reply(ctx.t("button-back"));
    session.other.cdn = { step: "idle" };
    return;
  }

  if (confirmCtx.callbackQuery.data !== "cdn_confirm") {
    return;
  }

  await confirmCtx.answerCallbackQuery();

  const price = Number(session.other.cdn.price);
  if (!(price > 0) || !Number.isFinite(price)) {
    await ctx.reply(ctx.t("cdn-error", { error: "Price not set" }), { parse_mode: "HTML" });
    session.other.cdn = { step: "idle" };
    return;
  }

  const dataSource = await getAppDataSource();
  const userRepo = dataSource.getRepository(User);
  const userId = session?.main?.user?.id;
  if (userId == null || userId <= 0) {
    await ctx.reply(ctx.t("cdn-error", { error: "User not found" }), { parse_mode: "HTML" });
    session.other.cdn = { step: "idle" };
    return;
  }
  const user = await userRepo.findOneBy({ id: userId });
  const bal = Number(user?.balance);
  if (!user || !Number.isFinite(bal) || bal < price) {
    await showTopupForMissingAmount(ctx, price - (Number.isFinite(bal) ? bal : 0));
    session.other.cdn = { step: "idle" };
    return;
  }

  user.balance -= price;
  await userRepo.save(user);
  session.main.user.balance = user.balance;

  const tid = session.other.cdn.telegramId ?? confirmCtx.from?.id ?? ctx.loadedUser?.telegramId;
  if (tid == null) {
    user.balance += price;
    await userRepo.save(user);
    session.main.user.balance = user.balance;
    await ctx.reply(ctx.t("cdn-error", { error: "User not found" }), { parse_mode: "HTML" });
    session.other.cdn = { step: "idle" };
    return;
  }

  try {
    const planId = cdnPlanIdOrDefault(session);
    const result = await cdnCreateProxy({
      telegramId: tid,
      username: ctx.from?.username,
      domainName: session.other.cdn.domainName!,
      targetUrl: session.other.cdn.targetUrl!,
      description: `plan=${planId}`,
      forceHttps: true,
      hostHeader: "incoming",
      cachingEnabled: false,
    });

    if (!result.success) {
      user.balance += price;
      await userRepo.save(user);
      session.main.user.balance = user.balance;
      await ctx.reply(ctx.t("cdn-error", { error: result.error ?? "Create failed" }), {
        parse_mode: "HTML",
      });
      session.other.cdn = { step: "idle" };
      return;
    }

    await ctx.reply(
      ctx.t("cdn-created", {
        domainName: session.other.cdn.domainName!,
        targetUrl: session.other.cdn.targetUrl!,
      }),
      { parse_mode: "HTML" }
    );
    if (result.data?.id) {
      await syncProxyRecordByItem(
        ctx,
        {
          id: result.data.id,
          domain_name: result.data.domain_name,
          target_url: result.data.target_url,
          status: result.data.status || "active",
          lifecycle_status: result.data.status || "active",
          server_ip: result.data.server_ip || null,
          expires_at: result.data.expires_at || null,
          created_at: new Date().toISOString(),
          auto_renew: false,
        },
        false
      );
    }
  } catch (e: any) {
    user.balance += price;
    await userRepo.save(user);
    session.main.user.balance = user.balance;
    await ctx.reply(ctx.t("cdn-error", { error: e?.message ?? "Request failed" }), {
      parse_mode: "HTML",
    });
  }

  session.other.cdn = { step: "idle" };
}

async function finalizeCdnCreateFromSession(ctx: AppContext, session: any): Promise<void> {
  await ensureSessionUser(ctx);
  const telegramId = ctx.from?.id ?? ctx.loadedUser?.telegramId;
  if (telegramId == null) {
    await ctx.reply(ctx.t("cdn-error", { error: "User not found" }), { parse_mode: "HTML" });
    session.other.cdn = { step: "idle" };
    return;
  }
  session.other.cdn.telegramId = telegramId;

  const domainName = String(session?.other?.cdn?.domainName ?? "");
  const targetUrl = String(session?.other?.cdn?.targetUrl ?? "");
  if (domainName && targetUrl && isSelfTarget(domainName, targetUrl)) {
    await ctx.reply(
      ctx.t("cdn-error", { error: "Origin URL must be different from CDN domain" }),
      { parse_mode: "HTML" }
    );
    session.other.cdn = { step: "idle" };
    return;
  }

  let price: number;
  try {
    price = await resolveCdnChargeUsd(session);
  } catch (e: any) {
    await ctx.reply(ctx.t("cdn-error", { error: e?.message ?? "Failed to get price" }), {
      parse_mode: "HTML",
    });
    session.other.cdn = { step: "idle" };
    return;
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    await ctx.reply(ctx.t("cdn-error", { error: "Invalid price" }), { parse_mode: "HTML" });
    session.other.cdn = { step: "idle" };
    return;
  }
  price = priceNum;
  session.other.cdn.price = price;

  const dataSource = await getAppDataSource();
  const userRepo = dataSource.getRepository(User);
  const userId = session?.main?.user?.id;
  if (userId == null || userId <= 0) {
    await ctx.reply(ctx.t("cdn-error", { error: "User not found" }), { parse_mode: "HTML" });
    session.other.cdn = { step: "idle" };
    return;
  }
  const user = await userRepo.findOneBy({ id: userId });
  const bal = Number(user?.balance);
  if (!user || !Number.isFinite(bal) || bal < price) {
    await showTopupForMissingAmount(ctx, price - (Number.isFinite(bal) ? bal : 0));
    session.other.cdn = { step: "idle" };
    return;
  }

  user.balance -= price;
  await userRepo.save(user);
  session.main.user.balance = user.balance;

  await ctx.reply("⏳ Подключаем CDN, обычно это занимает до 30 секунд...", {
    parse_mode: "HTML",
  }).catch(() => {});

  try {
    const planId = cdnPlanIdOrDefault(session);
    const result = await cdnCreateProxy({
      telegramId,
      username: ctx.from?.username,
      domainName: session.other.cdn.domainName!,
      targetUrl: session.other.cdn.targetUrl!,
      description: `plan=${planId}`,
      forceHttps: true,
      hostHeader: "incoming",
      cachingEnabled: false,
    });

    if (!result.success) {
      user.balance += price;
      await userRepo.save(user);
      session.main.user.balance = user.balance;
      await ctx.reply(ctx.t("cdn-error", { error: result.error ?? "Create failed" }), {
        parse_mode: "HTML",
      });
      session.other.cdn = { step: "idle" };
      return;
    }

    await ctx.reply(
      ctx.t("cdn-created", {
        domainName: session.other.cdn.domainName!,
        targetUrl: session.other.cdn.targetUrl!,
      }),
      { parse_mode: "HTML" }
    );
    if (result.data?.id) {
      await syncProxyRecordByItem(
        ctx,
        {
          id: result.data.id,
          domain_name: result.data.domain_name,
          target_url: result.data.target_url,
          status: result.data.status || "active",
          lifecycle_status: result.data.status || "active",
          server_ip: result.data.server_ip || null,
          expires_at: result.data.expires_at || null,
          created_at: new Date().toISOString(),
          auto_renew: false,
        },
        false
      );
    }
  } catch (e: any) {
    user.balance += price;
    await userRepo.save(user);
    session.main.user.balance = user.balance;
    await ctx.reply(ctx.t("cdn-error", { error: e?.message ?? "Request failed" }), {
      parse_mode: "HTML",
    });
  }

  session.other.cdn = { step: "idle" };
}

export async function handleCdnAddProxyTextInput(ctx: AppContext): Promise<boolean> {
  const session = (await ctx.session) as any;
  if (!session?.other?.cdn?.step) return false;
  if (!ctx.hasChatType("private")) return false;
  if (!ctx.message?.text) return false;

  const input = ctx.message.text.trim();
  if (!input || input.startsWith("/")) return false;

  if (session.other.cdn.step === "plan") {
    await ctx.reply(ctx.t("cdn-choose-plan-hint"), { parse_mode: "HTML" });
    await showCdnTariffsScreen(ctx, { useReply: true });
    return true;
  }

  if (session.other.cdn.step === "domain") {
    if (!session.other.cdn.planId) {
      await ctx.reply(ctx.t("cdn-choose-plan"), { parse_mode: "HTML" });
      await showCdnTariffsScreen(ctx, { useReply: true });
      return true;
    }
    if (!isValidDomain(input)) {
      await ctx.reply(ctx.t("cdn-invalid-domain"), { parse_mode: "HTML" });
      return true;
    }
    session.other.cdn.domainName = normalizeDomainInput(input);
    session.other.cdn.step = "target";
    await askTargetUrl(ctx);
    return true;
  }

  if (session.other.cdn.step === "target") {
    const normalized = normalizeTargetUrlInput(input);
    if (!normalized) {
      await ctx.reply(ctx.t("cdn-invalid-url"), { parse_mode: "HTML" });
      return true;
    }
    if (isSelfTarget(session.other.cdn.domainName ?? "", normalized)) {
      await ctx.reply(
        ctx.t("cdn-error", { error: "Origin URL must be different from CDN domain" }),
        { parse_mode: "HTML" }
      );
      return true;
    }
    session.other.cdn.targetUrl = normalized;
    await finalizeCdnCreateFromSession(ctx, session);
    return true;
  }

  return false;
}

function buildProxyActionKeyboard(ctx: AppContext, proxy: CdnProxyItem): InlineKeyboard {
  const isAutoRenew = proxy.auto_renew === true;
  return new InlineKeyboard()
    .text(ctx.t("button-cdn-renew"), `cdn_renew:${proxy.id}`)
    .text(
      isAutoRenew ? ctx.t("button-cdn-autorenew-off") : ctx.t("button-cdn-autorenew-on"),
      `cdn_autorenew:${proxy.id}:${isAutoRenew ? "0" : "1"}`
    )
    .row()
    .text(ctx.t("button-cdn-retry-ssl"), `cdn_retryssl:${proxy.id}`)
    .text(ctx.t("button-cdn-delete"), `cdn_delask:${proxy.id}`)
    .row()
    .text(ctx.t("button-cdn-refresh"), `cdn_open:${proxy.id}`)
    .text(ctx.t("button-back"), "cdn_list");
}

function buildDeleteConfirmKeyboard(ctx: AppContext, proxyId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t("button-confirm"), `cdn_delok:${proxyId}`)
    .text(ctx.t("button-cancel"), `cdn_open:${proxyId}`);
}

async function getProxyById(telegramId: number, proxyId: string): Promise<CdnProxyItem | null> {
  const list = await cdnListProxies(telegramId);
  return list.find((p) => p.id === proxyId) ?? null;
}

async function syncProxyRecordByItem(ctx: AppContext, p: CdnProxyItem, markDeleted = false): Promise<void> {
  const dataSource = await getAppDataSource();
  const repo = dataSource.getRepository(CdnProxyService);
  const session = await ctx.session;
  const userId = session.main.user.id;
  const telegramId = ctx.from?.id ?? ctx.loadedUser?.telegramId ?? 0;
  if (!telegramId || !userId) return;

  let rec = await repo.findOne({ where: { proxyId: p.id } });
  if (!rec) {
    rec = new CdnProxyService();
    rec.proxyId = p.id;
    rec.targetUserId = userId;
    rec.telegramId = telegramId;
  }
  rec.domainName = p.domain_name;
  rec.targetUrl = p.target_url ?? null;
  rec.status = p.status ?? null;
  rec.lifecycleStatus = p.lifecycle_status ?? null;
  rec.serverIp = p.server_ip ?? null;
  rec.expiresAt = p.expires_at ? new Date(p.expires_at) : null;
  rec.autoRenew = p.auto_renew === true;
  rec.isDeleted = markDeleted;
  rec.deletedAt = markDeleted ? new Date() : null;
  await repo.save(rec);
}

async function addAudit(
  ctx: AppContext,
  proxyId: string,
  action: string,
  success: boolean,
  note?: string
): Promise<void> {
  const dataSource = await getAppDataSource();
  const repo = dataSource.getRepository(CdnProxyAudit);
  const session = await ctx.session;
  const row = new CdnProxyAudit();
  row.proxyId = proxyId;
  row.actorUserId = session.main?.user?.id ?? null;
  row.actorTelegramId = (ctx.from?.id ?? ctx.loadedUser?.telegramId ?? null) as number | null;
  row.action = action;
  row.success = success;
  row.note = note ?? null;
  await repo.save(row);
}

async function showProxyCard(ctx: AppContext, proxy: CdnProxyItem, notice?: string): Promise<void> {
  const text = ctx.t("cdn-proxy-detail", {
    domain: proxy.domain_name,
    target: proxy.target_url || "—",
    status: proxy.lifecycle_status || proxy.status,
    expiresAt: proxy.expires_at || "—",
    autoRenew: proxy.auto_renew ? ctx.t("vds-autorenew-on") : ctx.t("vds-autorenew-off"),
  });
  const full = notice ? `${text}\n\n${notice}` : text;
  try {
    await ctx.editMessageText(full, {
      parse_mode: "HTML",
      reply_markup: buildProxyActionKeyboard(ctx, proxy),
    });
  } catch {
    await ctx.reply(full, {
      parse_mode: "HTML",
      reply_markup: buildProxyActionKeyboard(ctx, proxy),
    });
  }
}

function buildProxyListKeyboard(ctx: AppContext, proxies: CdnProxyItem[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const p of proxies) {
    const status = p.lifecycle_status || p.status;
    const buttonLabel = `🌐 ${p.domain_name} (${status})`;
    const safeLabel = buttonLabel.length > 60 ? `${buttonLabel.slice(0, 57)}...` : buttonLabel;
    keyboard.text(safeLabel, `cdn_open:${p.id}`).row();
  }
  keyboard.text(ctx.t("button-back"), "cdn_back_to_manage");
  return keyboard;
}

export async function openCdnManageList(ctx: AppContext, notice?: string): Promise<void> {
  const render = async (text: string, keyboard: InlineKeyboard): Promise<void> => {
    // For callback-driven menus prefer edit to avoid duplicate messages.
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch(() => {});
      return;
    }
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  };

  const telegramId = ctx.from?.id ?? ctx.loadedUser?.telegramId;
  if (!telegramId) {
    await ctx.reply(ctx.t("cdn-error", { error: "User not found" }), { parse_mode: "HTML" });
    return;
  }

  let proxies: CdnProxyItem[] = [];
  try {
    proxies = await Promise.race<CdnProxyItem[]>([
      cdnListProxies(telegramId),
      new Promise<CdnProxyItem[]>((resolve) => setTimeout(() => resolve([]), 2500)),
    ]);
  } catch {
    const title = ctx.t("cdn-manage-services-title");
    const text = notice ? `${title}\n\n${notice}` : title;
    const keyboard = new InlineKeyboard()
      .text(ctx.t("list-empty"), "cdn_empty_row")
      .row()
      .text(ctx.t("button-back"), "cdn_back_to_manage");
    await render(text, keyboard);
    return;
  }
  const active = proxies.filter((p) => (p.lifecycle_status || p.status) !== "deleted");
  if (active.length === 0) {
    const title = ctx.t("cdn-manage-services-title");
    const text = notice ? `${title}\n\n${notice}` : title;
    const keyboard = new InlineKeyboard()
      .text(ctx.t("list-empty"), "cdn_empty_row")
      .row()
      .text(ctx.t("button-back"), "cdn_back_to_manage");
    await render(text, keyboard);
    return;
  }

  const text = notice ? `${ctx.t("cdn-my-proxies-list")}\n\n${notice}` : ctx.t("cdn-my-proxies-list");
  const keyboard = buildProxyListKeyboard(ctx, active);
  await render(text, keyboard);
}

export async function handleCdnActionCallback(ctx: AppContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("cdn_")) return;
  await ctx.answerCallbackQuery().catch(() => {});
  await ensureSessionUser(ctx);

  if (data === "cdn_empty_row") {
    return;
  }

  if (data === "cdn_exit_services") {
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    const keepFromManage = session.other.cdn?.fromManage === true;
    session.other.cdn = { step: "idle", fromManage: keepFromManage };
    const { servicesMenu } = await import("../../helpers/services-menu.js");
    await ctx.editMessageText(ctx.t("menu-service-for-buy-choose"), {
      parse_mode: "HTML",
      reply_markup: servicesMenu,
    });
    return;
  }

  if (data === "cdn_nav:main") {
    await showCdnTariffsScreen(ctx);
    return;
  }

  if (data === "cdn_nav:tariffs") {
    if (!isCdnEnabled()) {
      await ctx.reply(ctx.t("cdn-not-configured"), { parse_mode: "HTML" });
      return;
    }
    await showCdnTariffsScreen(ctx);
    return;
  }

  if (data === "cdn_nav:proxy") {
    await showCdnProxyHubScreen(ctx);
    return;
  }

  if (data.startsWith("cdn_card:")) {
    if (!isCdnEnabled()) {
      await ctx.reply(ctx.t("cdn-not-configured"), { parse_mode: "HTML" });
      return;
    }
    const planId = parseCdnPlanId(data.slice("cdn_card:".length));
    if (!planId) return;
    await showCdnPlanCardScreen(ctx, planId);
    return;
  }

  if (data.startsWith("cdn_detail:")) {
    if (!isCdnEnabled()) {
      await ctx.reply(ctx.t("cdn-not-configured"), { parse_mode: "HTML" });
      return;
    }
    const planId = parseCdnPlanId(data.slice("cdn_detail:".length));
    if (!planId) return;
    await showCdnPlanDetailScreen(ctx, planId);
    return;
  }

  if (data === "cdn_prime_row") {
    try {
      const { getDomainsListWithPrimeScreen } = await import("../../ui/menus/amper-domains-menu.js");
      const { fullText, keyboard } = await getDomainsListWithPrimeScreen(ctx, {
        backCallback: "prime-back-to-cdn-tariffs",
      });
      await ctx.editMessageText(fullText, { reply_markup: keyboard, parse_mode: "HTML" });
    } catch (e: any) {
      await ctx
        .editMessageText(ctx.t("error-unknown", { error: e?.message || "Error" }))
        .catch(() => {});
    }
    return;
  }

  if (data === "cdn_back_to_manage") {
    const { manageSerivcesMenu } = await import("../../helpers/manage-services.js");
    await ctx.editMessageText(ctx.t("manage-services-header"), {
      parse_mode: "HTML",
      reply_markup: manageSerivcesMenu,
    });
    return;
  }

  if (data === "cdn_list") {
    await openCdnManageList(ctx);
    return;
  }

  if (data === "cdn_target_help") {
    await ctx.reply(ctx.t("cdn-target-help"), { parse_mode: "HTML" });
    return;
  }

  if (data === "cdn_target_auto") {
    const session = (await ctx.session) as any;
    if (!session?.other?.cdn || session.other.cdn.step !== "target") {
      await ctx.reply(ctx.t("cdn-target-auto-not-ready"), { parse_mode: "HTML" });
      return;
    }
    const domain = String(session.other.cdn.domainName ?? "").trim();
    if (!domain) {
      await ctx.reply(ctx.t("cdn-target-auto-not-ready"), { parse_mode: "HTML" });
      return;
    }
    const autoTarget = getCdnAutoTargetUrl();
    if (!autoTarget) {
      await ctx.reply(
        ctx.t("cdn-error", { error: "Auto origin is not configured. Contact support." }),
        { parse_mode: "HTML" }
      );
      return;
    }
    if (isSelfTarget(domain, autoTarget)) {
      await ctx.reply(
        ctx.t("cdn-error", { error: "Origin URL must be different from CDN domain" }),
        { parse_mode: "HTML" }
      );
      return;
    }
    session.other.cdn.targetUrl = autoTarget;
    await ctx.reply(
      ctx.t("cdn-target-auto-picked", {
        targetUrl: session.other.cdn.targetUrl,
      }),
      { parse_mode: "HTML" }
    );
    await finalizeCdnCreateFromSession(ctx, session);
    return;
  }

  if (data === "cdn_plan_back") {
    const session = (await ctx.session) as any;
    ensureCdnSession(session);
    const fromManage = session?.other?.cdn?.fromManage === true;
    session.other.cdn = { step: "idle", fromManage };
    if (fromManage) {
      await openCdnManageList(ctx);
    } else {
      await showCdnTariffsScreen(ctx);
    }
    return;
  }

  if (data.startsWith("cdn_plan:")) {
    if (!isCdnEnabled()) {
      await ctx.reply(ctx.t("cdn-not-configured"), { parse_mode: "HTML" });
      return;
    }
    const planId = parseCdnPlanId(data.slice("cdn_plan:".length));
    if (!planId) return;
    const session = (await ctx.session) as any;
    ensureCdnSession(session);
    const plan = getCdnPlan(planId);
    session.other.cdn.planId = planId;
    session.other.cdn.price = plan.priceUsd;
    session.other.cdn.step = "domain";
    session.other.cdn.telegramId = ctx.from?.id ?? ctx.loadedUser?.telegramId ?? session.other.cdn.telegramId;
    await ctx.reply(ctx.t("cdn-enter-domain"), { parse_mode: "HTML" });
    return;
  }

  if (!isCdnEnabled()) {
    await ctx.reply(ctx.t("cdn-not-configured"), { parse_mode: "HTML" });
    return;
  }

  const telegramId = ctx.from?.id ?? ctx.loadedUser?.telegramId;
  if (!telegramId) {
    await ctx.reply(ctx.t("cdn-error", { error: "User not found" }), { parse_mode: "HTML" });
    return;
  }

  const [action, p1, p2] = data.split(":");
  const proxyId = p1 || "";
  if (!proxyId) return;

  try {
    if (action === "cdn_open") {
      const proxy = await getProxyById(telegramId, proxyId);
      if (!proxy) {
        await ctx.reply(ctx.t("cdn-error", { error: "Proxy not found" }), { parse_mode: "HTML" });
        return;
      }
      await showProxyCard(ctx, proxy);
      await syncProxyRecordByItem(ctx, proxy, false);
      await addAudit(ctx, proxyId, "open", true);
      return;
    }

    if (action === "cdn_renew") {
      const ok = await cdnRenewProxy(proxyId, telegramId);
      const proxy = await getProxyById(telegramId, proxyId);
      if (proxy) {
        await syncProxyRecordByItem(ctx, proxy, false);
        await showProxyCard(ctx, proxy, ok ? ctx.t("cdn-renew-success") : ctx.t("cdn-renew-failed"));
      } else {
        await ctx.reply(ok ? ctx.t("cdn-renew-success") : ctx.t("cdn-renew-failed"), {
          parse_mode: "HTML",
        });
      }
      await addAudit(ctx, proxyId, "renew", ok);
      return;
    }

    if (action === "cdn_autorenew") {
      const enabled = p2 === "1";
      const ok = await cdnToggleAutoRenew(proxyId, telegramId, enabled);
      const proxy = await getProxyById(telegramId, proxyId);
      const note = ok
        ? enabled
          ? ctx.t("cdn-autorenew-on-success")
          : ctx.t("cdn-autorenew-off-success")
        : ctx.t("cdn-autorenew-failed");
      if (proxy) {
        await syncProxyRecordByItem(ctx, proxy, false);
        await showProxyCard(ctx, proxy, note);
      } else {
        await ctx.reply(note, { parse_mode: "HTML" });
      }
      await addAudit(ctx, proxyId, enabled ? "autorenew_on" : "autorenew_off", ok);
      return;
    }

    if (action === "cdn_retryssl") {
      const ok = await cdnRetrySsl(proxyId, telegramId);
      const proxy = await getProxyById(telegramId, proxyId);
      if (proxy) {
        await syncProxyRecordByItem(ctx, proxy, false);
        await showProxyCard(
          ctx,
          proxy,
          ok ? ctx.t("cdn-retry-ssl-success") : ctx.t("cdn-retry-ssl-failed")
        );
      } else {
        await ctx.reply(ok ? ctx.t("cdn-retry-ssl-success") : ctx.t("cdn-retry-ssl-failed"), {
          parse_mode: "HTML",
        });
      }
      await addAudit(ctx, proxyId, "retry_ssl", ok);
      return;
    }

    if (action === "cdn_delask") {
      const proxy = await getProxyById(telegramId, proxyId);
      if (!proxy) {
        await ctx.reply(ctx.t("cdn-error", { error: "Proxy not found" }), { parse_mode: "HTML" });
        return;
      }
      try {
        await ctx.editMessageText(ctx.t("cdn-delete-confirm"), {
          parse_mode: "HTML",
          reply_markup: buildDeleteConfirmKeyboard(ctx, proxyId),
        });
      } catch {
        await ctx.reply(ctx.t("cdn-delete-confirm"), {
          parse_mode: "HTML",
          reply_markup: buildDeleteConfirmKeyboard(ctx, proxyId),
        });
      }
      return;
    }

    if (action === "cdn_delok") {
      const proxyForDelete = await getProxyById(telegramId, proxyId);
      const ok = await cdnDeleteProxy(proxyId, telegramId, {
        domainName: proxyForDelete?.domain_name,
        targetUrl: proxyForDelete?.target_url,
      });
      if (ok) {
        const dataSource = await getAppDataSource();
        const repo = dataSource.getRepository(CdnProxyService);
        const rec = await repo.findOne({ where: { proxyId } });
        if (rec) {
          rec.isDeleted = true;
          rec.deletedAt = new Date();
          await repo.save(rec);
        }
        await addAudit(ctx, proxyId, "delete", true);
        await openCdnManageList(ctx, ctx.t("cdn-delete-success"));
      } else {
        await addAudit(ctx, proxyId, "delete", false);
        await ctx.reply(ctx.t("cdn-delete-failed"), { parse_mode: "HTML" });
      }
      return;
    }
  } catch (e: any) {
    await addAudit(ctx, proxyId, action, false, e?.message ?? "Unknown");
    await ctx.reply(ctx.t("cdn-error", { error: e?.message ?? "Unknown" }), {
      parse_mode: "HTML",
    });
  }
}
