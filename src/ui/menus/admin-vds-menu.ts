/**
 * Admin panel: list/search/manage VDS (VMManager-backed).
 *
 * @module ui/menus/admin-vds-menu
 */

import { InlineKeyboard } from "grammy";
import axios from "axios";
import type { AppContext } from "../../shared/types/context.js";
import type { SessionData } from "../../shared/types/session.js";
import { Role } from "../../entities/User.js";
import { VdsRepository } from "../../infrastructure/db/repositories/VdsRepository.js";
import { VdsService } from "../../domain/services/VdsService.js";
import { BillingService } from "../../domain/billing/BillingService.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { TopUpRepository } from "../../infrastructure/db/repositories/TopUpRepository.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import { ensureSessionUser } from "../../shared/utils/session-user.js";

const PAGE_SIZE = 10;
const GEOIP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const geoIpCache = new Map<string, { value: string; expiresAt: number }>();
const geoIpInFlight = new Map<string, Promise<string>>();
const userDisplayCache = new Map<number, string>();
const userShortCache = new Map<number, string>();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isPublicIpv4(ip: string): boolean {
  const trimmed = ip.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return false;
  if (trimmed === "0.0.0.0" || trimmed === "127.0.0.1") return false;
  if (trimmed.startsWith("10.") || trimmed.startsWith("192.168.")) return false;
  if (trimmed.startsWith("169.254.")) return false;
  const second = Number(trimmed.split(".")[1] ?? "0");
  if (trimmed.startsWith("172.") && second >= 16 && second <= 31) return false;
  return true;
}

async function lookupGeoLocation(ip: string): Promise<string> {
  if (!isPublicIpv4(ip)) return "Unknown";
  const cached = geoIpCache.get(ip);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const inFlight = geoIpInFlight.get(ip);
  if (inFlight) return inFlight;

  const request = (async () => {
    try {
      const { data } = await axios.get<{
        success?: boolean;
        country_code?: string;
        country?: string;
        city?: string;
      }>(`https://ipwho.is/${encodeURIComponent(ip)}`, { timeout: 2500 });

      const countryCode = String(data?.country_code || "").trim();
      const country = String(data?.country || "").trim();
      const city = String(data?.city || "").trim();
      const location = countryCode
        ? city
          ? `${countryCode} / ${city}`
          : countryCode
        : country
          ? city
            ? `${country} / ${city}`
            : country
          : "Unknown";
      geoIpCache.set(ip, { value: location, expiresAt: now + GEOIP_CACHE_TTL_MS });
      return location;
    } catch {
      geoIpCache.set(ip, { value: "Unknown", expiresAt: now + 10 * 60 * 1000 });
      return "Unknown";
    } finally {
      geoIpInFlight.delete(ip);
    }
  })();

  geoIpInFlight.set(ip, request);
  return request;
}

async function resolveBuyerDisplay(ctx: AppContext, telegramId?: number): Promise<string> {
  if (!telegramId) return "ID: -";
  const cached = userDisplayCache.get(telegramId);
  if (cached) return cached;

  let display = `ID: ${telegramId}`;
  try {
    const chat = await ctx.api.getChat(telegramId);
    const username = "username" in chat ? String(chat.username || "").trim() : "";
    if (username) {
      display = `@${escapeHtml(username)} (ID: ${telegramId})`;
    }
  } catch {
    // fallback already set
  }

  userDisplayCache.set(telegramId, display);
  return display;
}

async function resolveBuyerShort(ctx: AppContext, telegramId?: number): Promise<string> {
  if (!telegramId) return "ID:-";
  const cached = userShortCache.get(telegramId);
  if (cached) return cached;

  let short = `ID:${telegramId}`;
  try {
    const chat = await ctx.api.getChat(telegramId);
    const username = "username" in chat ? String(chat.username || "").trim() : "";
    if (username) {
      short = `@${escapeHtml(username)}`;
    }
  } catch {
    // fallback already set
  }

  userShortCache.set(telegramId, short);
  return short;
}

function vdsService(ctx: AppContext): VdsService {
  const vdsRepo = new VdsRepository(ctx.appDataSource);
  const userRepo = new UserRepository(ctx.appDataSource);
  const topUpRepo = new TopUpRepository(ctx.appDataSource);
  const billing = new BillingService(ctx.appDataSource, userRepo, topUpRepo);
  return new VdsService(ctx.appDataSource, vdsRepo, billing, ctx.vmmanager);
}

/**
 * Clears VDS admin list filters when leaving the section (back to admin root).
 * Prevents an old search from hiding all rows on the next visit.
 */
export function clearAdminVdsPanelState(other: SessionData["other"]): void {
  if (!other.adminVds) return;
  other.adminVds.searchQuery = "";
  other.adminVds.page = 0;
  other.adminVds.selectedVdsId = null;
  other.adminVds.awaitingSearch = false;
  other.adminVds.awaitingTransferUserId = false;
}

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

export async function replyAdminVdsList(ctx: AppContext): Promise<void> {
  if (!(await requireAdmin(ctx))) return;
  const text = await buildListText(ctx);
  const kb = await buildListKeyboard(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function openAdminVdsPanel(ctx: AppContext): Promise<void> {
  if (!(await requireAdmin(ctx))) return;
  const session = await ctx.session;
  if (!session.other.adminVds) {
    session.other.adminVds = {
      page: 0,
      searchQuery: "",
      selectedVdsId: null,
      awaitingSearch: false,
      awaitingTransferUserId: false,
    };
  }
  clearAdminVdsPanelState(session.other);
  const text = await buildListText(ctx);
  const kb = await buildListKeyboard(ctx);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    // When admin presses the button from a non-editable/old message, still open panel via new message.
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function buildListText(ctx: AppContext): Promise<string> {
  const session = await ctx.session;
  const ad = session.other.adminVds;
  const vdsRepo = new VdsRepository(ctx.appDataSource);
  const [list, total] = await vdsRepo.findPaginatedForAdmin(
    ad.page * PAGE_SIZE,
    PAGE_SIZE,
    ad.searchQuery || undefined
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const header = ctx.t("admin-vds-title", {
    page: ad.page + 1,
    totalPages,
  });
  if (list.length === 0) {
    return `${header}\n\n${ctx.t("admin-vds-empty")}`;
  }
  const userRepo = new UserRepository(ctx.appDataSource);
  const lines = await Promise.all(
    list.map(async (v, idx) => {
      const owner = await userRepo.findById(v.targetUserId);
      const buyer = await resolveBuyerShort(ctx, owner?.telegramId ?? undefined);

      const n = ad.page * PAGE_SIZE + idx + 1;
      return `${n}. ${escapeHtml(v.ipv4Addr || "—")} - ${buyer}`;
    })
  );
  return `${header}\n\n${lines.join("\n")}`;
}

async function buildListKeyboard(ctx: AppContext): Promise<InlineKeyboard> {
  const session = await ctx.session;
  const ad = session.other.adminVds;
  const vdsRepo = new VdsRepository(ctx.appDataSource);
  const [list, total] = await vdsRepo.findPaginatedForAdmin(
    ad.page * PAGE_SIZE,
    PAGE_SIZE,
    ad.searchQuery || undefined
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const kb = new InlineKeyboard();
  list.forEach((v, idx) => {
    const n = ad.page * PAGE_SIZE + idx + 1;
    const ip = (v.ipv4Addr || "—").trim();
    const label = `${n}. ${ip}`.substring(0, 64);
    kb.text(label, `adv:sel:${v.id}`).row();
  });
  if (totalPages > 1) {
    kb.text("◀", `adv:pg:${Math.max(0, ad.page - 1)}`)
      .text(`${ad.page + 1}/${totalPages}`, "adv:noop")
      .text("▶", `adv:pg:${Math.min(totalPages - 1, ad.page + 1)}`)
      .row();
  }
  kb.text(ctx.t("admin-vds-search-button"), "adv:search").row();
  kb.text(ctx.t("button-back"), "admin-menu-back");
  return kb;
}

async function buildDetailText(ctx: AppContext, v: VirtualDedicatedServer): Promise<string> {
  const vmInfo = await ctx.vmmanager.getInfoVM(v.vdsId).catch(() => undefined);
  const vmStateRaw = vmInfo?.state ?? "unknown";
  const userRepo = new UserRepository(ctx.appDataSource);
  const owner = await userRepo.findById(v.targetUserId);
  const userDisplay = await resolveBuyerDisplay(ctx, owner?.telegramId ?? undefined);
  const ip = v.ipv4Addr || "-";
  const location = await lookupGeoLocation(ip);
  const created = v.createdAt ? new Date(v.createdAt) : null;
  const expires = v.expireAt ? new Date(v.expireAt) : null;
  const now = Date.now();
  const daysLeft =
    expires && Number.isFinite(expires.getTime())
      ? Math.max(0, Math.ceil((expires.getTime() - now) / (24 * 60 * 60 * 1000)))
      : null;
  const formatIsoDate = (d: Date | null): string =>
    d && Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "-";

  let operationalState = "ACTIVE";
  if (v.adminBlocked) operationalState = "BLOCKED";
  else if (v.managementLocked) operationalState = "LOCKED";
  else if (vmStateRaw === "stopped") operationalState = "STOPPED";

  const vmStateLabel =
    vmStateRaw === "active" ? "Running" : vmStateRaw === "stopped" ? "Stopped" : "Unknown";
  const provider = "Cloud";
  const price = Number(v.renewalPrice ?? 0).toFixed(2);
  const planName = v.rateName || "-";
  const cpu = Number.isFinite(v.cpuCount) ? `${v.cpuCount} vCore` : "-";
  const ram = Number.isFinite(v.ramSize) ? `${v.ramSize}GB` : "-";
  const disk = Number.isFinite(v.diskSize) ? `${v.diskSize}GB` : "-";
  const daysSuffix = daysLeft == null ? "-" : `+${daysLeft}d`;
  const login = (v.login || "root").trim() || "root";
  const password = String(v.password || "").trim();
  const passwordDisplay = password
    ? escapeHtml(password)
    : login.toLowerCase().includes("ssh")
      ? "SSH Key Only"
      : "Not set";

  return [
    `<b>VDS #${v.id} • ${operationalState}</b>`,
    "",
    `👤 User: ${userDisplay}`,
    `💰 Plan: $${price}/mo (${planName})`,
    `📅 Created: ${formatIsoDate(created)}`,
    `⏳ Expires: ${formatIsoDate(expires)} (${daysSuffix})`,
    "",
    `🌍 IP: <code>${ip}</code>`,
    `📍 Location: ${location}`,
    "",
    `🔐 Access:`,
    `👤 Login: ${escapeHtml(login)}`,
    `🔑 Password: ${passwordDisplay}`,
    "",
    `⚙️ CPU: ${cpu} | RAM: ${ram} | Disk: ${disk}`,
    "",
    `🔄 Status: ${vmStateLabel}`,
    `🧱 Provider: ${provider}`,
    `🆔 VMID: <code>${v.vdsId}</code>`,
    "",
    ctx.t("admin-vds-proxmox-search-hint", { vmid: v.vdsId }),
    ctx.t("admin-vds-bot-ids-line", { serviceId: v.id, userId: v.targetUserId }),
  ].join("\n");
}

function detailKeyboard(
  v: VirtualDedicatedServer,
  deleteConfirm = false,
  vmState: "active" | "stopped" | "unknown" = "unknown"
): InlineKeyboard {
  if (deleteConfirm) {
    return new InlineKeyboard()
      .text("✅ OK delete", `adv:delok:${v.id}`)
      .text("❌ Cancel", `adv:sel:${v.id}`)
      .row()
      .text("◀ Back", `adv:sel:${v.id}`);
  }

  const kb = new InlineKeyboard()
    .text("⛔/✅ Block", `adv:blk:${v.id}`)
    .text("+30d", `adv:ext:${v.id}`)
    .row()
    .text("🔀 Transfer", `adv:tr:${v.id}`)
    .text("🔄 Sync IP", `adv:syncip:${v.id}`);

  kb.row();
  if (vmState === "active") {
    kb.text("⏹ Stop", `adv:stop:${v.id}`).text("♻ Reboot", `adv:reboot:${v.id}`);
  } else if (vmState === "stopped") {
    kb.text("▶ Start", `adv:start:${v.id}`);
  } else {
    kb.text("▶ Start", `adv:start:${v.id}`).text("⏹ Stop", `adv:stop:${v.id}`);
  }
  kb.text("🗑 Delete", `adv:delask:${v.id}`).row();
  kb.row().text("◀ List", "adv:list");
  return kb;
}

async function syncVdsIp(ctx: AppContext, v: VirtualDedicatedServer): Promise<boolean> {
  const ipResult = await ctx.vmmanager.getIpv4AddrVM(v.vdsId).catch(() => undefined);
  const freshIp = ipResult?.list?.[0]?.ip_addr;
  if (!freshIp || freshIp === "0.0.0.0" || freshIp === "127.0.0.1") {
    return false;
  }
  if (v.ipv4Addr !== freshIp) {
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    v.ipv4Addr = freshIp;
    await vdsRepo.save(v);
  }
  return true;
}

export async function handleAdminVdsCallback(ctx: AppContext): Promise<void> {
  if (!(await requireAdmin(ctx))) return;
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("adv:")) return;
  await ctx.answerCallbackQuery().catch(() => {});

  const session = await ctx.session;
  if (!session.other.adminVds) {
    session.other.adminVds = {
      page: 0,
      searchQuery: "",
      selectedVdsId: null,
      awaitingSearch: false,
      awaitingTransferUserId: false,
    };
  }
  const ad = session.other.adminVds;
  const rest = data.slice(4);
  if (rest === "noop") return;

  if (rest === "list") {
    ad.selectedVdsId = null;
    await ctx.editMessageText(await buildListText(ctx), {
      parse_mode: "HTML",
      reply_markup: await buildListKeyboard(ctx),
    });
    return;
  }

  if (rest.startsWith("pg:")) {
    ad.page = Math.max(0, parseInt(rest.slice(3), 10) || 0);
    await ctx.editMessageText(await buildListText(ctx), {
      parse_mode: "HTML",
      reply_markup: await buildListKeyboard(ctx),
    });
    return;
  }

  if (rest === "search") {
    if (session.other.promoAdmin) {
      session.other.promoAdmin.createStep = null;
      session.other.promoAdmin.editStep = null;
      session.other.promoAdmin.createDraft = {};
      session.other.promoAdmin.editingPromoId = null;
    }
    ad.awaitingSearch = true;
    await ctx.reply(ctx.t("admin-vds-search-prompt"), { parse_mode: "HTML" });
    return;
  }

  if (rest.startsWith("sel:")) {
    const id = parseInt(rest.slice(4), 10);
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    const v = await vdsRepo.findById(id);
    if (!v) {
      await ctx.reply(ctx.t("bad-error"));
      return;
    }
    ad.selectedVdsId = id;
    const vmInfo = await ctx.vmmanager.getInfoVM(v.vdsId).catch(() => undefined);
    const vmStateRaw = String(vmInfo?.state ?? "").toLowerCase();
    const vmState: "active" | "stopped" | "unknown" =
      vmStateRaw === "active" ? "active" : vmStateRaw === "stopped" ? "stopped" : "unknown";
    await ctx.editMessageText(await buildDetailText(ctx, v), {
      parse_mode: "HTML",
      reply_markup: detailKeyboard(v, false, vmState),
    });
    return;
  }

  if (rest.startsWith("delask:")) {
    const id = parseInt(rest.slice(7), 10);
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    const v = await vdsRepo.findById(id);
    if (!v) {
      await ctx.reply(ctx.t("bad-error"));
      return;
    }
    ad.selectedVdsId = id;
    await ctx.editMessageText(ctx.t("admin-vds-delete-confirm"), {
      parse_mode: "HTML",
      reply_markup: detailKeyboard(v, true),
    });
    return;
  }

  if (rest.startsWith("syncip:")) {
    const id = parseInt(rest.slice(7), 10);
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    const v = await vdsRepo.findById(id);
    if (!v) {
      await ctx.reply(ctx.t("bad-error"));
      return;
    }
    const synced = await syncVdsIp(ctx, v);
    const refreshed = await vdsRepo.findById(id);
    if (!refreshed) return;
    await ctx.reply(synced ? ctx.t("admin-vds-ip-synced") : ctx.t("admin-vds-ip-not-available"), { parse_mode: "HTML" });
    await ctx.editMessageText(await buildDetailText(ctx, refreshed), {
      parse_mode: "HTML",
      reply_markup: detailKeyboard(refreshed, false, "unknown"),
    });
    return;
  }

  if (rest.startsWith("start:") || rest.startsWith("stop:") || rest.startsWith("reboot:")) {
    const [action, idStr] = rest.split(":");
    const id = parseInt(idStr ?? "", 10);
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    const v = await vdsRepo.findById(id);
    if (!v) {
      await ctx.reply(ctx.t("bad-error"));
      return;
    }
    try {
      if (action === "start") {
        await ctx.vmmanager.startVM(v.vdsId);
      } else if (action === "stop") {
        await ctx.vmmanager.stopVM(v.vdsId);
      } else {
        await ctx.vmmanager.stopVM(v.vdsId).catch(() => {});
        await ctx.vmmanager.startVM(v.vdsId);
      }
      await syncVdsIp(ctx, v).catch(() => {});
      const refreshed = await vdsRepo.findById(id);
      if (refreshed) {
        const successMessage =
          action === "start"
            ? ctx.t("admin-vds-vm-started")
            : action === "stop"
              ? ctx.t("admin-vds-vm-stopped")
              : ctx.t("admin-vds-vm-rebooted");
        await ctx.reply(successMessage, { parse_mode: "HTML" });
        await ctx.editMessageText(await buildDetailText(ctx, refreshed), {
          parse_mode: "HTML",
          reply_markup: detailKeyboard(refreshed, false, action === "start" ? "active" : action === "stop" ? "stopped" : "unknown"),
        });
      }
    } catch (e: any) {
      await ctx.reply(ctx.t("error-unknown", { error: e?.message || "err" }));
    }
    return;
  }

  if (rest.startsWith("blk:")) {
    const id = parseInt(rest.slice(4), 10);
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    const v = await vdsRepo.findById(id);
    if (!v) return;
    const svc = vdsService(ctx);
    await svc.adminSetBlocked(id, !v.adminBlocked);
    const v2 = await vdsRepo.findById(id);
    if (v2) {
      await ctx.editMessageText(await buildDetailText(ctx, v2), {
        parse_mode: "HTML",
        reply_markup: detailKeyboard(v2, false, "unknown"),
      });
    }
    return;
  }

  if (rest.startsWith("ext:")) {
    const id = parseInt(rest.slice(4), 10);
    const svc = vdsService(ctx);
    await svc.adminExtendByDays(id, 30);
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    const v2 = await vdsRepo.findById(id);
    if (v2) {
      await ctx.reply(ctx.t("admin-vds-extended", { days: 30 }));
      await ctx.editMessageText(await buildDetailText(ctx, v2), {
        parse_mode: "HTML",
        reply_markup: detailKeyboard(v2, false, "unknown"),
      });
    }
    return;
  }

  if (rest.startsWith("tr:")) {
    const id = parseInt(rest.slice(4), 10);
    ad.selectedVdsId = id;
    ad.awaitingTransferUserId = true;
    await ctx.reply(ctx.t("admin-vds-transfer-prompt"), { parse_mode: "HTML" });
    return;
  }

  if (rest.startsWith("delok:")) {
    const id = parseInt(rest.slice(6), 10);
    const svc = vdsService(ctx);
    try {
      await svc.deleteVds(id);
      await ctx.reply(ctx.t("admin-vds-deleted"));
    } catch (e: any) {
      await ctx.reply(ctx.t("error-unknown", { error: e?.message || "err" }));
    }
    ad.selectedVdsId = null;
    await ctx.editMessageText(await buildListText(ctx), {
      parse_mode: "HTML",
      reply_markup: await buildListKeyboard(ctx),
    });
    return;
  }
}
