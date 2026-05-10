import { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import { Role } from "../../entities/User.js";
import CdnProxyService from "../../entities/CdnProxyService.js";
import CdnProxyAudit from "../../entities/CdnProxyAudit.js";
import { ensureSessionUser } from "../../shared/utils/session-user.js";
import { cdnDeleteProxy, cdnListProxies } from "../../infrastructure/cdn/CdnClient.js";

const PAGE_SIZE = 10;

async function requireAdmin(ctx: AppContext): Promise<boolean> {
  const ok = await ensureSessionUser(ctx);
  const session = await ctx.session;
  if (!ok || !session || session.main.user.role !== Role.Admin) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
    } else {
      await ctx.reply(ctx.t("error-access-denied"), { parse_mode: "HTML" }).catch(() => {});
    }
    return false;
  }
  return true;
}

async function ensureAdminCdnState(ctx: AppContext): Promise<void> {
  const session = await ctx.session;
  if (!session.other.adminCdn) {
    session.other.adminCdn = {
      page: 0,
      searchQuery: "",
      selectedProxyId: null,
      awaitingSearch: false,
    };
  }
}

async function queryList(ctx: AppContext): Promise<[CdnProxyService[], number]> {
  const session = await ctx.session;
  const state = session.other.adminCdn!;
  const repo = ctx.appDataSource.getRepository(CdnProxyService);
  const qb = repo.createQueryBuilder("c");
  if (state.searchQuery.trim()) {
    const q = `%${state.searchQuery.trim()}%`;
    qb.where("c.proxyId LIKE :q OR c.domainName LIKE :q OR c.targetUrl LIKE :q", { q });
  }
  qb.orderBy("c.id", "DESC").skip(state.page * PAGE_SIZE).take(PAGE_SIZE);
  return qb.getManyAndCount();
}

function listKeyboard(list: CdnProxyService[], page: number, totalPages: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of list) {
    kb.text(`#${item.id} ${item.domainName}`.substring(0, 60), `acdn:sel:${item.id}`).row();
  }
  if (totalPages > 1) {
    kb.text("◀", `acdn:pg:${Math.max(0, page - 1)}`)
      .text(`${page + 1}/${totalPages}`, "acdn:noop")
      .text("▶", `acdn:pg:${Math.min(totalPages - 1, page + 1)}`)
      .row();
  }
  kb.text("🔍", "acdn:search").text("♻️", "acdn:sync");
  return kb;
}

export async function openAdminCdnPanel(ctx: AppContext): Promise<void> {
  if (!(await requireAdmin(ctx))) return;
  await ensureAdminCdnState(ctx);
  const session = await ctx.session;
  const [list, total] = await queryList(ctx);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const text = [
    ctx.t("admin-cdn-title", { page: session.other.adminCdn!.page + 1, totalPages }),
    "",
    ...(list.length
      ? list.map((c) =>
          ctx.t("admin-cdn-row", {
            id: c.id,
            domain: c.domainName,
            status: c.lifecycleStatus || c.status || "—",
          })
        )
      : [ctx.t("admin-cdn-empty")]),
  ].join("\n");
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: listKeyboard(list, session.other.adminCdn!.page, totalPages),
  });
}

function itemKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🗑 Delete", `acdn:delask:${id}`)
    .text("♻️ Sync owner", `acdn:syncone:${id}`)
    .row()
    .text("◀ List", "acdn:list");
}

function itemDeleteConfirmKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ OK delete", `acdn:delok:${id}`)
    .text("❌", `acdn:sel:${id}`)
    .row()
    .text("◀ List", "acdn:list");
}

async function addAudit(
  ctx: AppContext,
  proxyId: string,
  action: string,
  success: boolean,
  note?: string
): Promise<void> {
  const repo = ctx.appDataSource.getRepository(CdnProxyAudit);
  const session = await ctx.session;
  const row = new CdnProxyAudit();
  row.proxyId = proxyId;
  row.actorUserId = session.main?.user?.id ?? null;
  row.actorTelegramId = (ctx.from?.id ?? ctx.loadedUser?.telegramId ?? null) as number | null;
  row.action = `admin_${action}`;
  row.success = success;
  row.note = note ?? null;
  await repo.save(row);
}

export async function handleAdminCdnCallback(ctx: AppContext): Promise<void> {
  if (!(await requireAdmin(ctx))) return;
  await ensureAdminCdnState(ctx);
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("acdn:")) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const session = await ctx.session;
  const state = session.other.adminCdn!;
  const repo = ctx.appDataSource.getRepository(CdnProxyService);
  const rest = data.slice(5);
  if (rest === "noop") return;
  if (rest === "list") {
    await openAdminCdnPanel(ctx);
    return;
  }
  if (rest === "search") {
    state.awaitingSearch = true;
    await ctx.reply(ctx.t("admin-cdn-search-prompt"), { parse_mode: "HTML" });
    return;
  }
  if (rest.startsWith("pg:")) {
    state.page = Math.max(0, parseInt(rest.slice(3), 10) || 0);
    await openAdminCdnPanel(ctx);
    return;
  }
  if (rest.startsWith("sel:")) {
    const id = parseInt(rest.slice(4), 10);
    const item = await repo.findOne({ where: { id } });
    if (!item) {
      await ctx.reply(ctx.t("bad-error"));
      return;
    }
    state.selectedProxyId = item.proxyId;
    await ctx.editMessageText(
      ctx.t("admin-cdn-detail", {
        id: item.id,
        proxyId: item.proxyId,
        domain: item.domainName,
        target: item.targetUrl || "—",
        status: item.lifecycleStatus || item.status || "—",
        expiresAt: item.expiresAt || "—",
        deleted: item.isDeleted ? "yes" : "no",
      }),
      { parse_mode: "HTML", reply_markup: itemKeyboard(item.id) }
    );
    return;
  }
  if (rest.startsWith("syncone:")) {
    const id = parseInt(rest.slice(8), 10);
    const item = await repo.findOne({ where: { id } });
    if (!item) return;
    try {
      const list = await cdnListProxies(item.telegramId);
      const p = list.find((x) => x.id === item.proxyId);
      if (!p) {
        item.isDeleted = true;
        item.deletedAt = new Date();
      } else {
        item.domainName = p.domain_name;
        item.targetUrl = p.target_url ?? null;
        item.status = p.status ?? null;
        item.lifecycleStatus = p.lifecycle_status ?? null;
        item.serverIp = p.server_ip ?? null;
        item.expiresAt = p.expires_at ? new Date(p.expires_at) : null;
        item.autoRenew = p.auto_renew === true;
        item.isDeleted = false;
        item.deletedAt = null;
      }
      await repo.save(item);
      await ctx.reply(ctx.t("admin-cdn-sync-success"), { parse_mode: "HTML" });
    } catch (e: any) {
      await ctx.reply(ctx.t("error-unknown", { error: e?.message || "err" }), {
        parse_mode: "HTML",
      });
    }
    return;
  }
  if (rest === "sync") {
    const [list] = await queryList(ctx);
    for (const item of list) {
      try {
        const remote = await cdnListProxies(item.telegramId);
        const p = remote.find((x) => x.id === item.proxyId);
        if (!p) {
          item.isDeleted = true;
          item.deletedAt = new Date();
        } else {
          item.domainName = p.domain_name;
          item.targetUrl = p.target_url ?? null;
          item.status = p.status ?? null;
          item.lifecycleStatus = p.lifecycle_status ?? null;
          item.serverIp = p.server_ip ?? null;
          item.expiresAt = p.expires_at ? new Date(p.expires_at) : null;
          item.autoRenew = p.auto_renew === true;
          item.isDeleted = false;
          item.deletedAt = null;
        }
        await repo.save(item);
      } catch {
        // continue
      }
    }
    await ctx.reply(ctx.t("admin-cdn-sync-success"), { parse_mode: "HTML" });
    await openAdminCdnPanel(ctx);
    return;
  }
  if (rest.startsWith("delask:")) {
    const id = parseInt(rest.slice(7), 10);
    const item = await repo.findOne({ where: { id } });
    if (!item) return;
    await ctx.editMessageText(
      `${ctx.t("admin-cdn-detail", {
        id: item.id,
        proxyId: item.proxyId,
        domain: item.domainName,
        target: item.targetUrl || "—",
        status: item.lifecycleStatus || item.status || "—",
        expiresAt: item.expiresAt || "—",
        deleted: item.isDeleted ? "yes" : "no",
      })}\n\n${ctx.t("cdn-delete-confirm")}`,
      { parse_mode: "HTML", reply_markup: itemDeleteConfirmKeyboard(item.id) }
    );
    return;
  }
  if (rest.startsWith("delok:")) {
    const id = parseInt(rest.slice(6), 10);
    const item = await repo.findOne({ where: { id } });
    if (!item) return;
    const ok = await cdnDeleteProxy(item.proxyId, item.telegramId, {
      domainName: item.domainName,
      targetUrl: item.targetUrl,
    });
    if (ok) {
      item.isDeleted = true;
      item.deletedAt = new Date();
      await repo.save(item);
      await ctx.reply(ctx.t("cdn-delete-success"), { parse_mode: "HTML" });
      await addAudit(ctx, item.proxyId, "delete", true);
    } else {
      await ctx.reply(ctx.t("cdn-delete-failed"), { parse_mode: "HTML" });
      await addAudit(ctx, item.proxyId, "delete", false);
    }
    await openAdminCdnPanel(ctx);
  }
}

