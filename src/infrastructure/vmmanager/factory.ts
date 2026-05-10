import { config, isProxmoxEnabled } from "../../app/config.js";
import { Logger } from "../../app/logger.js";
import { VMManager } from "./VMManager.js";
import { ProxmoxProvider } from "./ProxmoxProvider.js";
import type { VmProvider } from "./provider.js";

export function createVmProvider(): VmProvider {
  const provider = (config.VM_PROVIDER ?? "vmmanager").toLowerCase();
  if (provider === "proxmox" && isProxmoxEnabled()) {
    Logger.info("Using Proxmox VM provider");
    return new ProxmoxProvider();
  }
  Logger.info("Using VMManager provider");
  return new VMManager(process.env["VMM_EMAIL"] ?? "", process.env["VMM_PASSWORD"] ?? "");
}
