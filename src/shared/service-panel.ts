/**
 * Shared helpers for rendering service info panels.
 *
 * @module shared/service-panel
 */

import type { AppContext } from "./types/context.js";
import { escapeUserInput } from "../helpers/formatting.js";

const maskPassword = (value: string): string => {
  if (!value) {
    return "••••••";
  }
  const length = Math.min(value.length, 8);
  return "•".repeat(length);
};

const formatValue = (ctx: AppContext, value: string | null | undefined): string => {
  if (!value) {
    return ctx.t("not-specified");
  }
  return escapeUserInput(value);
};

const formatDate = (ctx: AppContext, value?: Date | null): string => {
  if (!value) {
    return ctx.t("not-specified");
  }
  return ctx.t("service-date", { date: value });
};

export interface ServiceInfoBlockData {
  ip?: string | null;
  login?: string | null;
  password?: string | null;
  showPassword: boolean;
  os?: string | null;
  statusLabel: string;
  createdAt?: Date | null;
  paidUntil?: Date | null;
  /** Proxmox/VM Manager guest VMID */
  vmHostId?: number | null;
}

/**
 * Build HTML info block for service details.
 */
export const buildServiceInfoBlock = (
  ctx: AppContext,
  data: ServiceInfoBlockData
): string => {
  const passwordValue = data.showPassword
    ? formatValue(ctx, data.password)
    : maskPassword(data.password || "");

  const lines = [
    `<strong>${ctx.t("service-info-header")}</strong>`,
    `<strong>${ctx.t("service-label-ip")}:</strong> ${formatValue(ctx, data.ip)}`,
    `<strong>${ctx.t("service-label-login")}:</strong> ${formatValue(ctx, data.login)}`,
    `<strong>${ctx.t("service-label-password")}:</strong> ${passwordValue}`,
    `<strong>${ctx.t("service-label-os")}:</strong> ${formatValue(ctx, data.os)}`,
    `<strong>${ctx.t("service-label-status")}:</strong> ${data.statusLabel}`,
    `<strong>${ctx.t("service-label-created-at")}:</strong> ${formatDate(ctx, data.createdAt)}`,
    `<strong>${ctx.t("service-label-paid-until")}:</strong> ${formatDate(ctx, data.paidUntil)}`,
  ];
  if (data.vmHostId != null && Number.isFinite(Number(data.vmHostId))) {
    lines.push(
      `<strong>${ctx.t("service-label-vm-host-id")}:</strong> <code>${escapeUserInput(String(data.vmHostId))}</code>`
    );
  }
  return lines.join("\n");
};
