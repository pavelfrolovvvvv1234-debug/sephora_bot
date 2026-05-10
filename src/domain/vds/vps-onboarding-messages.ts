/**
 * Premium VPS post-provision copy + HTML layout (Telegram parse_mode: HTML).
 */

import type { AppContext } from "../../shared/types/context.js";

const DEFAULT_VPS_CPU_MODEL = "Xeon E5-2699v4";

export function getVpsCpuModelForRate(rate: { cpuModel?: string }): string {
  const model = rate.cpuModel?.trim();
  return model && model.length > 0 ? model : DEFAULT_VPS_CPU_MODEL;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type PremiumVpsReadyPayload = {
  vmName: string;
  vdsId: number;
  regionLabel: string;
  planName: string;
  cpu: number;
  ramGb: number;
  diskGb: number;
  networkMbps: number;
  cpuModel: string;
  osLabel: string;
  ipv4: string;
  login: string;
  password: string;
};

function isValidPublicIpv4(ip: string): boolean {
  return Boolean(ip && ip !== "0.0.0.0" && ip !== "127.0.0.1");
}

/** Single HTML message: specs + SSH access + console hint. */
export function buildPremiumVpsReadyHtml(ctx: AppContext, p: PremiumVpsReadyPayload): string {
  const e = escapeHtml;
  const ipOk = isValidPublicIpv4(p.ipv4);
  const sep = "\n───────────────\n";

  const head = ctx.t("vps-premium-headline");
  const specLine = ctx.t("vps-premium-specs-line", {
    cpu: p.cpu,
    ram: p.ramGb,
    disk: p.diskGb,
    net: p.networkMbps,
    cpuModel: e(p.cpuModel),
  });

  const blockInstance = [
    `<b>${ctx.t("vps-premium-sec-instance")}</b>`,
    ctx.t("vps-premium-host-and-id", { host: e(p.vmName), id: e(String(p.vdsId)) }),
    `${ctx.t("vps-premium-k-region")} <code>${e(p.regionLabel)}</code>`,
    `${ctx.t("vps-premium-k-plan")} <code>${e(p.planName)}</code>`,
    `${ctx.t("vps-premium-k-specs")} ${specLine}`,
    `${ctx.t("vps-premium-k-os")} <code>${e(p.osLabel)}</code>`,
  ].join("\n");

  let blockAccess = `${sep}<b>${ctx.t("vps-premium-sec-access")}</b>\n`;
  if (!ipOk) {
    blockAccess += `\n${ctx.t("vps-premium-ipv4-pending")}\n`;
    blockAccess += `\n<b>${ctx.t("vps-premium-k-user")}</b> <code>${e(p.login)}</code>`;
    blockAccess += `\n<b>${ctx.t("vps-premium-k-password")}</b> <code>${e(p.password)}</code>`;
  } else {
    blockAccess += `\n<b>${ctx.t("vps-premium-k-ipv4")}</b>\n<code>${e(p.ipv4)}</code>`;
    blockAccess += `\n\n<b>${ctx.t("vps-premium-k-user")}</b> <code>${e(p.login)}</code>`;
    blockAccess += `\n<b>${ctx.t("vps-premium-k-password")}</b> <code>${e(p.password)}</code>`;
    const ssh = `ssh ${p.login}@${p.ipv4}`;
    blockAccess += `\n\n<b>${ctx.t("vps-premium-k-ssh")}</b>\n<pre>${e(ssh)}</pre>`;
  }

  const foot = `${sep}<i>${ctx.t("vps-premium-console-hint")}</i>`;

  return [head, "", blockInstance, blockAccess, foot].join("\n");
}
