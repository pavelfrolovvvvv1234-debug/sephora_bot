import axios, { type AxiosInstance } from "axios";
import https from "https";
import {
  config,
  getProxmoxTemplateMap,
  isProxmoxInsecureTls,
} from "../../app/config.js";
import { Logger } from "../../app/logger.js";
import { generatePassword } from "../../entities/VirtualDedicatedServer.js";
import { retry } from "../../shared/utils/retry.js";
import type {
  CreateVMSuccesffulyResponse,
  GetOsListResponse,
  ListItem,
  Os,
} from "../../api/vmmanager.js";
import type { VmProvider } from "./provider.js";
import { isVpsLinuxOsKey } from "../../shared/vps-linux-os-keys.js";

type ProxmoxTemplate = {
  vmid: number;
  name?: string;
  template?: 0 | 1;
};

type ProxmoxNetworkIface = {
  iface?: string;
  address?: string;
  cidr?: string;
  gateway?: string;
  type?: string;
  active?: 0 | 1;
};

type ProxmoxGuestKind = "qemu" | "lxc";

/** QEMU/LXC config snippets from GET …/config */
type ProxmoxGuestConfig = {
  name?: string;
  hostname?: string;
  cores?: number;
  memory?: number;
  net0?: string;
};

type ClusterVmRow = {
  node?: string;
  status?: string;
  name?: string;
  maxcpu?: number;
  maxmem?: number;
  virtType?: ProxmoxGuestKind;
};

function normalizeOsKey(key: string): string {
  return key.trim().toLowerCase();
}

export class ProxmoxProvider implements VmProvider {
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly node: string;
  private readonly storage: string;
  private readonly bridge: string;
  private readonly templateMap: Record<string, number>;
  private readonly reverseTemplateMap: Record<number, string>;
  private readonly httpTimeoutMs: number;
  private clusterNodeNamesCache: { names: string[]; at: number } | null = null;
  private readonly clusterNodeNamesTtlMs = 60_000;
  private lastCreateVmFailureDetail = "";

  constructor() {
    this.baseUrl = (config.PROXMOX_BASE_URL ?? process.env.PROXMOX_BASE_URL ?? "").trim().replace(/\/+$/, "");
    this.node = (config.PROXMOX_NODE ?? process.env.PROXMOX_NODE ?? "").trim();
    this.storage = (config.PROXMOX_STORAGE ?? process.env.PROXMOX_STORAGE ?? "").trim();
    this.bridge = (config.PROXMOX_BRIDGE ?? process.env.PROXMOX_BRIDGE ?? "vmbr0").trim();
    this.templateMap = getProxmoxTemplateMap();
    this.reverseTemplateMap = Object.fromEntries(
      Object.entries(this.templateMap).map(([k, v]) => [v, k])
    );

    const tokenId = (config.PROXMOX_TOKEN_ID ?? process.env.PROXMOX_TOKEN_ID ?? "").trim();
    const tokenSecret = (config.PROXMOX_TOKEN_SECRET ?? process.env.PROXMOX_TOKEN_SECRET ?? "").trim();
    const insecureTls = isProxmoxInsecureTls();
    const timeoutRaw = (process.env.PROXMOX_HTTP_TIMEOUT_MS ?? "").trim();
    const timeoutParsed = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
    this.httpTimeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed >= 10_000 ? timeoutParsed : 120_000;

    this.client = axios.create({
      baseURL: `${this.baseUrl}/api2/json`,
      timeout: this.httpTimeoutMs,
      headers: {
        Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
      },
      httpsAgent: insecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    });

    Logger.info(
      insecureTls
        ? "Proxmox provider initialized (TLS certificate verification disabled for this API URL)"
        : "Proxmox provider initialized (TLS verification enabled)"
    );
  }

  /** Exposed for VPS shop flow when `createVM` returns false. */
  getLastCreateVmFailureDetail(): string {
    return this.lastCreateVmFailureDetail;
  }

  private recordProvisionFailure(detail: string): void {
    const t = detail.trim();
    if (t) this.lastCreateVmFailureDetail = t.slice(0, 2000);
  }

  private isRetryableTransportError(error: unknown): boolean {
    const e = error as any;
    const code = String(e?.code ?? "");
    const message = String(e?.message ?? "");
    // Axios timeout: code ECONNABORTED or message "timeout of Xms exceeded"
    if (code === "ECONNABORTED" || message.includes("timeout of")) return true;
    if (code === "ETIMEDOUT" || code === "ECONNRESET") return true;
    const status = Number(e?.response?.status ?? 0);
    // Retry 502/503/504 from proxy / pveproxy under load
    if ([502, 503, 504].includes(status)) return true;
    return false;
  }

  /** Flatten Proxmox / Axios error body for logs and retry heuristics. */
  private extractProxmoxErrorMessage(error: unknown): string {
    const e = error as any;
    const raw = e?.response?.data;
    if (raw && typeof raw === "object") {
      const err = (raw as { errors?: unknown; message?: string }).errors;
      if (typeof err === "string") return err;
      if (err && typeof err === "object") {
        try {
          return JSON.stringify(err);
        } catch {
          return String(err);
        }
      }
      const msg = (raw as { message?: string }).message;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
    return String(e?.message ?? error ?? "");
  }

  /**
   * Whether createVM should take another pass (new /cluster/nextid, clone again).
   * Covers VMID races, HA locks, transient proxy errors — not TLS misconfig or auth.
   */
  private shouldRetryProvisioningAfterError(error: unknown, detail: string): boolean {
    if (this.isRetryableTransportError(error)) return true;
    const d = detail.toLowerCase();
    if (d.includes("unable to verify") || d.includes("certificate") || d.includes("self signed")) return false;
    if (d.includes("401") || d.includes("403") || d.includes("permission") || d.includes("authentication"))
      return false;
    const status = Number((error as any)?.response?.status ?? 0);
    if (status === 409) return true;
    if (
      /\balready exist/.test(d) ||
      /\bduplicate\b/.test(d) ||
      /\bvmid\b.*\bexist/.test(d) ||
      /\bvm id\b.*\bexist/.test(d) ||
      /\bvm \d+ already exists\b/.test(d) ||
      /\bconflict\b/.test(d) ||
      (d.includes("lock") && d.includes("timeout")) ||
      d.includes("got timeout") ||
      d.includes("try again")
    ) {
      return true;
    }
    return [502, 503, 504].includes(status);
  }

  private async apiGet<T>(url: string): Promise<T> {
    const run = async (): Promise<T> => {
      const { data } = await this.client.get<{ data: T }>(url);
      return data.data;
    };
    return retry(run, {
      maxAttempts: 3,
      delayMs: 800,
      exponentialBackoff: true,
      onRetry: (_attempt, err) => {
        if (!this.isRetryableTransportError(err)) throw err;
      },
    });
  }

  private async apiPost<T>(url: string, body?: Record<string, unknown>): Promise<T> {
    const run = async (): Promise<T> => {
      // Proxmox API expects HTML form encoding for POST bodies (not JSON) for most write calls.
      const flat = body ?? {};
      const keys = Object.keys(flat).filter((k) => flat[k] !== undefined && flat[k] !== null);
      let response;
      if (keys.length === 0) {
        response = await this.client.post<{ data: T }>(url);
      } else {
        const params = new URLSearchParams();
        for (const k of keys) {
          params.append(k, String(flat[k]));
        }
        response = await this.client.post<{ data: T }>(url, params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
      }
      return response.data.data;
    };
    return retry(run, {
      maxAttempts: 3,
      delayMs: 800,
      exponentialBackoff: true,
      onRetry: (_attempt, err) => {
        if (!this.isRetryableTransportError(err)) throw err;
      },
    });
  }

  /** Proxmox uses PUT for some write operations (e.g. qemu disk resize). Same form body as {@link apiPost}. */
  private async apiPut<T>(url: string, body?: Record<string, unknown>): Promise<T> {
    const run = async (): Promise<T> => {
      const flat = body ?? {};
      const keys = Object.keys(flat).filter((k) => flat[k] !== undefined && flat[k] !== null);
      let response;
      if (keys.length === 0) {
        response = await this.client.put<{ data: T }>(url);
      } else {
        const params = new URLSearchParams();
        for (const k of keys) {
          params.append(k, String(flat[k]));
        }
        response = await this.client.put<{ data: T }>(url, params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
      }
      return response.data.data;
    };
    return retry(run, {
      maxAttempts: 3,
      delayMs: 800,
      exponentialBackoff: true,
      onRetry: (_attempt, err) => {
        if (!this.isRetryableTransportError(err)) throw err;
      },
    });
  }

  /**
   * Extend QEMU disk (PVE API viewer: HTTP PUT …/qemu/{vmid}/resize — POST returns 501 "not implemented").
   * Fallback: same path with query string if a proxy strips PUT bodies.
   */
  private async qemuResizeDisk(node: string, vmid: number, diskKey: string, size: string): Promise<void> {
    const path = `/nodes/${node}/qemu/${vmid}/resize`;
    const body = { disk: diskKey, size };
    try {
      await this.apiPut(path, body);
      return;
    } catch (first) {
      const msg = this.extractProxmoxErrorMessage(first).toLowerCase();
      const status = Number((first as any)?.response?.status ?? 0);
      const retry =
        status === 501 ||
        msg.includes("not implemented") ||
        (msg.includes("resize") && msg.includes("post"));
      if (!retry) throw first;
      Logger.warn(`Proxmox qemuResizeDisk vmid=${vmid}: PUT form failed (${msg}), retrying PUT with query string`);
    }
    const qs = new URLSearchParams({ disk: diskKey, size }).toString();
    const { data } = await this.client.put<{ data: unknown }>(`${path}?${qs}`);
    void data;
  }

  private async apiDelete<T>(url: string): Promise<T> {
    const run = async (): Promise<T> => {
      const { data } = await this.client.delete<{ data: T }>(url);
      return data.data;
    };
    return retry(run, {
      maxAttempts: 3,
      delayMs: 800,
      exponentialBackoff: true,
      onRetry: (_attempt, err) => {
        if (!this.isRetryableTransportError(err)) throw err;
      },
    });
  }

  /** Poll PVE async task (clone returns UPID string in `data`). */
  private async waitForTaskFinished(
    primaryNode: string,
    upid: string,
    timeoutMs = 900_000
  ): Promise<{ ok: boolean; detail: string }> {
    const encoded = encodeURIComponent(upid);
    const nodes = [...new Set([primaryNode, this.node].filter((n): n is string => Boolean(n?.trim())))];
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const node of nodes) {
        try {
          const st = await this.apiGet<{ status?: string; exitstatus?: string }>(
            `/nodes/${node}/tasks/${encoded}/status`
          );
          const status = String(st?.status ?? "").toLowerCase();
          if (status === "stopped") {
            const exit = String(st?.exitstatus ?? "");
            const ok = exit.toUpperCase() === "OK";
            if (!ok) {
              const tail = await this.fetchTaskLogTail(node, encoded).catch(() => "");
              return {
                ok: false,
                detail: tail ? `${exit || "ERR"}: ${tail}` : exit || "clone task failed",
              };
            }
            return { ok: true, detail: "" };
          }
        } catch {
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { ok: false, detail: "clone task status timeout" };
  }

  private async fetchTaskLogTail(node: string, upidEncoded: string, maxLines = 12): Promise<string> {
    const rows = await this.apiGet<Array<{ t?: string }>>(`/nodes/${node}/tasks/${upidEncoded}/log`).catch(
      () => undefined
    );
    if (!Array.isArray(rows)) return "";
    const lines = rows.map((r) => String(r?.t ?? "").trim()).filter(Boolean);
    return lines.slice(-maxLines).join(" | ");
  }

  private async waitForVmStopped(id: number, timeoutMs = 20000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const node = await this.findQemuNodeHostingVmid(id);
      if (!node) {
        return;
      }
      const status = await this.apiGet<{ status?: string }>(`/nodes/${node}/qemu/${id}/status/current`).catch(
        () => undefined
      );
      if (!status || status.status === "stopped") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /** Map OS list id / template key to source template vmid for clone. */
  private resolveTemplateSourceVmid(osId: number): number | undefined {
    if (Number.isFinite(osId) && this.reverseTemplateMap[osId]) {
      return osId;
    }
    return this.templateMap[normalizeOsKey(String(osId))];
  }

  private async waitUntilQemuGuestAbsent(vmid: number, timeoutMs = 90000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const host = await this.findQemuNodeHostingVmid(vmid);
      if (!host) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return false;
  }

  /** After async clone, config may not exist until Proxmox finishes disk copy. Guest may land on target node or briefly elsewhere — resolve node via cluster index. */
  private async waitUntilGuestConfigReadable(vmid: number, timeoutMs = 180000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const node = await this.findQemuNodeHostingVmid(vmid);
      if (node) {
        const cfg = await this.apiGet<unknown>(`/nodes/${node}/qemu/${vmid}/config`).catch(() => undefined);
        if (cfg != null) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return false;
  }

  /** Qemu disk config keys vary by template (virtio0 vs scsi0). Prefer common boot-slot names first. */
  private findPrimaryQemuDiskKey(cfg: Record<string, unknown>): string | undefined {
    const re = /^(?:scsi|virtio|sata|ide)\d+$/;
    const candidates = Object.keys(cfg).filter((k) => {
      if (!re.test(k)) return false;
      const raw = cfg[k];
      const v = typeof raw === "string" ? raw : "";
      if (!v.includes(":") || v.trim().startsWith("none")) return false;
      const lower = v.toLowerCase();
      // Skip non-root disks: cloud-init drive and virtual cdrom.
      if (lower.includes("cloudinit") || lower.includes("media=cdrom")) return false;
      return true;
    });
    if (candidates.length === 0) return undefined;
    const bySizeDesc = [...candidates].sort((a, b) => {
      const aRaw = typeof cfg[a] === "string" ? (cfg[a] as string) : undefined;
      const bRaw = typeof cfg[b] === "string" ? (cfg[b] as string) : undefined;
      const aSize = this.sizeLiteralToBytes(this.parseDiskSizeFromVolume(aRaw)) ?? 0;
      const bSize = this.sizeLiteralToBytes(this.parseDiskSizeFromVolume(bRaw)) ?? 0;
      return bSize - aSize;
    });
    if (bySizeDesc.length > 0) {
      const top = bySizeDesc[0];
      if (top) return top;
    }
    const rank = (k: string): number => {
      if (k === "virtio0") return 0;
      if (k === "scsi0") return 1;
      if (k === "sata0") return 2;
      if (k === "ide0") return 3;
      return 10;
    };
    candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return candidates[0];
  }

  /** Parse `size=32G` from a Proxmox volume line (absolute size for qm resize). */
  private parseDiskSizeFromVolume(volLine?: string): string | undefined {
    if (!volLine) return undefined;
    const m = volLine.match(/size=([0-9.]+[KMGTP])/i);
    return m?.[1];
  }

  /** Convert Proxmox size literal (e.g. 32G) to bytes for safe comparisons. */
  private sizeLiteralToBytes(size?: string): number | undefined {
    if (!size) return undefined;
    const m = size.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP])$/i);
    if (!m) return undefined;
    const value = Number(m[1]);
    const unit = String(m[2] ?? "").toUpperCase();
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const unitPow: Record<string, number> = { K: 1, M: 2, G: 3, T: 4, P: 5 };
    const pow = unitPow[unit];
    if (!pow) return undefined;
    return Math.trunc(value * 1024 ** pow);
  }

  /**
   * Virtio NIC bandwidth cap (mbps = megabit/s). Mirrors ISP VMManager net_in/out intent for egress-heavy defaults.
   * Proxmox applies `rate` to virtio egress per upstream docs.
   */
  private buildVirtioNet0(networkIn: number, networkOut: number): string {
    const base = `virtio,bridge=${this.bridge}`;
    const mbps = Math.max(
      Number.isFinite(networkIn) ? Math.trunc(networkIn) : 0,
      Number.isFinite(networkOut) ? Math.trunc(networkOut) : 0
    );
    return mbps > 0 ? `${base},rate=${mbps}` : base;
  }

  private ipToInt(ip: string): number {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 0;
    return (((parts[0] ?? 0) << 24) >>> 0) + ((parts[1] ?? 0) << 16) + ((parts[2] ?? 0) << 8) + (parts[3] ?? 0);
  }

  private intToIp(ipInt: number): string {
    return [
      (ipInt >>> 24) & 255,
      (ipInt >>> 16) & 255,
      (ipInt >>> 8) & 255,
      ipInt & 255,
    ].join(".");
  }

  private parseIpFromIpConfig(ipConfig?: string): string | undefined {
    if (!ipConfig) return undefined;
    const match = ipConfig.match(/(?:^|,)ip=([0-9.]+)\/\d+/);
    return match?.[1];
  }

  private async getBridgeNetworkConfig(): Promise<{ cidr: string; gateway: string } | undefined> {
    try {
      const interfaces = await this.apiGet<ProxmoxNetworkIface[]>(`/nodes/${this.node}/network`);
      const bridge = interfaces.find((iface) => iface.iface === this.bridge);
      const cidr = bridge?.cidr ?? (bridge?.address?.includes("/") ? bridge.address : undefined);
      const gateway = bridge?.gateway;
      if (!cidr || !gateway) return undefined;
      return { cidr, gateway };
    } catch (error) {
      Logger.warn("Failed to read Proxmox bridge network config", error);
      return undefined;
    }
  }

  private async pickFreeIpv4FromBridge(): Promise<{ ipconfig0: string; nameserver: string } | undefined> {
    const bridgeConfig = await this.getBridgeNetworkConfig();
    if (!bridgeConfig) return undefined;

    const [networkIp, prefixStr] = bridgeConfig.cidr.split("/");
    const prefix = Number(prefixStr);
    if (!networkIp || !Number.isInteger(prefix) || prefix < 16 || prefix > 30) return undefined;

    const networkInt = this.ipToInt(networkIp);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const subnetBase = networkInt & mask;

    const usedIps = new Set<string>([bridgeConfig.gateway, networkIp]);
    try {
      const vms = await this.apiGet<Array<{ vmid: number }>>(`/nodes/${this.node}/qemu`);
      for (const vm of vms) {
        const config = await this.apiGet<{ ipconfig0?: string }>(`/nodes/${this.node}/qemu/${vm.vmid}/config`).catch(() => undefined);
        const existingIp = this.parseIpFromIpConfig(config?.ipconfig0);
        if (existingIp) usedIps.add(existingIp);
      }
    } catch (error) {
      Logger.warn("Failed to build used IPv4 set from Proxmox config", error);
    }

    // Keep a safe allocation range in the same /24-like segment.
    const startHost = 100;
    const endHost = 250;
    for (let host = startHost; host <= endHost; host++) {
      const candidate = this.intToIp((subnetBase + host) >>> 0);
      if (usedIps.has(candidate)) continue;
      return {
        ipconfig0: `ip=${candidate}/${prefix},gw=${bridgeConfig.gateway}`,
        nameserver: "1.1.1.1",
      };
    }

    return undefined;
  }

  private buildOsItem(id: number, key: string): Os {
    return {
      adminonly: false,
      clusters: { id: 1, name: this.node },
      comment: null,
      cpu_mode: null,
      efi_boot: false,
      hdd_mib_required: 10240,
      id,
      is_lxd_image: false,
      kms_ip: null,
      kms_port: null,
      kms_supported: false,
      min_ram_mib: 1024,
      name: key,
      nodes: { id: 1, ip_addr: "", name: this.node, ssh_port: 22 },
      os_group: "custom",
      product_key: null,
      repository: "local",
      repository_id: 0,
      state: "active",
      tags: [],
      updated_at: new Date().toISOString(),
    };
  }

  /** QEMU guests flagged as template anywhere in the cluster (for OS list + clone source checks). */
  private async listClusterQemuTemplateVmids(): Promise<Set<number>> {
    const out = new Set<number>();
    try {
      const resources = await this.apiGet<
        Array<{ type?: string; vmid?: number; template?: number }>
      >(`/cluster/resources?type=vm`);
      if (Array.isArray(resources)) {
        for (const r of resources) {
          if (r.type != null && r.type !== "" && r.type !== "qemu") continue;
          if (Number(r.template) !== 1 || r.vmid == null) continue;
          out.add(Number(r.vmid));
        }
      }
    } catch {
      // fall through to node-local list
    }
    if (out.size > 0) return out;
    try {
      const list = await this.apiGet<ProxmoxTemplate[]>(`/nodes/${this.node}/qemu`);
      if (Array.isArray(list)) {
        for (const t of list) {
          if (t.template === 1 && t.vmid != null) out.add(Number(t.vmid));
        }
      }
    } catch {
      // ignore
    }
    return out;
  }

  async getOsList(): Promise<GetOsListResponse | undefined> {
    try {
      const templateVmIds = await this.listClusterQemuTemplateVmids();
      const list = Object.entries(this.templateMap)
        .filter(([key, vmid]) => isVpsLinuxOsKey(key) && templateVmIds.has(vmid))
        .map(([key, vmid]) => this.buildOsItem(vmid, key));
      return { last_notify: Date.now(), list };
    } catch (error) {
      Logger.error("Proxmox getOsList failed", error);
      return undefined;
    }
  }

  /**
   * QEMU clone must be called on the node where the source template guest exists.
   * PROXMOX_NODE is often the target for new VMs, not where templates live.
   */
  private async findQemuNodeHostingVmid(vmid: number): Promise<string | undefined> {
    try {
      const resources = await this.apiGet<
        Array<{ type?: string; vmid?: number; node?: string }>
      >(`/cluster/resources?type=vm`);
      if (Array.isArray(resources)) {
        const row = resources.find(
          (r) =>
            Number(r.vmid) === vmid &&
            (r.type === "qemu" || r.type === "openvz" || r.type === undefined || r.type === "")
        );
        const node = row?.node?.trim();
        if (node) return node;
      }
    } catch (error) {
      Logger.warn("Proxmox findQemuNodeHostingVmid: cluster/resources failed, scanning nodes", error);
    }
    const nodes = await this.listClusterNodeNames();
    for (const node of nodes) {
      try {
        const list = await this.apiGet<Array<{ vmid?: number }>>(`/nodes/${node}/qemu`);
        if (Array.isArray(list) && list.some((g) => Number(g.vmid) === vmid)) return node;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * When {@link findQemuNodeHostingVmid} fails, explain via `/cluster/resources` (wrong VM type, missing guest, etc.).
   */
  private async explainMissingQemuTemplate(vmid: number): Promise<string> {
    try {
      const resources = await this.apiGet<
        Array<{ type?: string; vmid?: number; node?: string; name?: string }>
      >(`/cluster/resources?type=vm`);
      if (Array.isArray(resources)) {
        const row = resources.find((r) => Number(r.vmid) === vmid);
        if (row) {
          const t = String(row.type ?? "").toLowerCase();
          const where = row.node ? ` on node "${row.node.trim()}"` : "";
          if (t === "lxc") {
            return `template vmid=${vmid} is an LXC container${where}, not QEMU — clone needs a KVM template; fix PROXMOX_TEMPLATE_MAP or create a QEMU golden image`;
          }
          if (t === "qemu") {
            return `template vmid=${vmid} appears as QEMU${where} but node lookup failed — check API token can see cluster/nodes and guest is not orphaned`;
          }
          return `template vmid=${vmid} has type "${row.type ?? "?"}"${where} — VPS clone requires QEMU (KVM)`;
        }
      }
    } catch {
      /* fall through */
    }
    return `template vmid=${vmid} not in cluster API — in Proxmox create a QEMU template with this VMID or change PROXMOX_TEMPLATE_MAP to your real template VMIDs (Datacenter → cluster → VMs)`;
  }

  /** Delete guest wherever it lives (clone target may differ from PROXMOX_NODE). */
  private async purgeQemuGuestBestEffort(vmid: number): Promise<void> {
    const hosting = await this.findQemuNodeHostingVmid(vmid);
    const candidates = [...new Set([hosting, this.node].filter((n): n is string => Boolean(n?.trim())))];
    const nodes = candidates.length > 0 ? candidates : [this.node];
    for (const node of nodes) {
      try {
        await this.apiPost(`/nodes/${node}/qemu/${vmid}/status/stop`).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        await this.apiDelete(`/nodes/${node}/qemu/${vmid}?purge=1&skiplock=1`);
        return;
      } catch {
        continue;
      }
    }
    await this.deleteVM(vmid).catch(() => {});
  }

  async createVM(
    name: string,
    password: string,
    cpuNumber: number,
    ramSize: number,
    osId: number,
    comment: string,
    diskSize: number,
    ipv4Count: number,
    networkIn: number,
    networkOut: number
  ): Promise<CreateVMSuccesffulyResponse | false> {
    this.lastCreateVmFailureDetail = "";
    const templateId = this.resolveTemplateSourceVmid(osId);
    if (!templateId) {
      this.recordProvisionFailure(`template not found for osId=${osId}`);
      Logger.warn(`Proxmox template not found for osId=${osId}`);
      return false;
    }
    const templateKey =
      this.reverseTemplateMap[templateId] ??
      Object.entries(this.templateMap).find(([, v]) => v === templateId)?.[0];
    if (!templateKey || !isVpsLinuxOsKey(templateKey)) {
      this.recordProvisionFailure(`not a Sephora Linux template osId=${osId} vmid=${templateId}`);
      Logger.warn(`Proxmox createVM: template is not a Sephora Linux image osId=${osId} vmid=${templateId}`);
      return false;
    }

    const templateNode = await this.findQemuNodeHostingVmid(templateId);
    if (!templateNode) {
      const detail = await this.explainMissingQemuTemplate(templateId);
      this.recordProvisionFailure(detail);
      Logger.error(
        `Proxmox createVM: template QEMU vmid=${templateId} not usable for clone (${detail})`
      );
      return false;
    }
    if (templateNode !== this.node) {
      Logger.info(
        `Proxmox createVM: template vmid=${templateId} is on node "${templateNode}", cloning with target="${this.node}"`
      );
    }

    const maxAttempts = 6;
    let lastFailureDetail = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let newId: number | undefined;
      const rollbackGuest = async (reason: string): Promise<void> => {
        if (newId == null) return;
        try {
          await this.purgeQemuGuestBestEffort(newId);
        } catch (cleanupErr) {
          Logger.warn(`Proxmox createVM: rollback purge failed vmid=${newId} (${reason})`, cleanupErr);
        }
      };

      try {
        const nextIdRaw = await this.apiGet<string>(`/cluster/nextid`);
        const parsedVmId = Number(nextIdRaw);
        if (Number.isNaN(parsedVmId)) {
          lastFailureDetail = `invalid nextid response: ${String(nextIdRaw)}`;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          this.recordProvisionFailure(lastFailureDetail);
          return false;
        }
        newId = parsedVmId;
        const autoIpConfig = await this.pickFreeIpv4FromBridge();

        const clonePayload: Record<string, unknown> = {
          newid: newId,
          name,
          full: 1,
        };
        const storageTrim = this.storage?.trim();
        if (storageTrim) clonePayload.storage = storageTrim;
        if (templateNode !== this.node) {
          clonePayload.target = this.node;
        }

        const cloneResult = await this.apiPost<string>(
          `/nodes/${templateNode}/qemu/${templateId}/clone`,
          clonePayload
        );

        if (typeof cloneResult === "string" && cloneResult.startsWith("UPID:")) {
          const taskOutcome = await this.waitForTaskFinished(templateNode, cloneResult, 600_000);
          if (!taskOutcome.ok) {
            lastFailureDetail = `clone task: ${taskOutcome.detail}`;
            Logger.warn(`Proxmox createVM attempt ${attempt}/${maxAttempts}: ${lastFailureDetail}`);
            await rollbackGuest("clone task failed");
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 600)));
              continue;
            }
            this.recordProvisionFailure(lastFailureDetail);
            return false;
          }
        }

        const clonedReady = await this.waitUntilGuestConfigReadable(newId, 180000);
        if (!clonedReady) {
          lastFailureDetail = `clone config not readable within timeout vmid=${newId}`;
          Logger.warn(`Proxmox createVM attempt ${attempt}/${maxAttempts}: ${lastFailureDetail}`);
          await rollbackGuest("clone timeout");
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 600)));
            continue;
          }
          this.recordProvisionFailure(lastFailureDetail);
          return false;
        }

        const vmNode = (await this.findQemuNodeHostingVmid(newId)) ?? this.node;

        const baselineCfg =
          (await this.apiGet<Record<string, unknown>>(`/nodes/${vmNode}/qemu/${newId}/config`).catch(() => undefined)) ??
          {};
        const diskKey = this.findPrimaryQemuDiskKey(baselineCfg);
        if (!diskKey) {
          lastFailureDetail = `no disk slot vmid=${newId} keys=${Object.keys(baselineCfg).join(",")}`;
          Logger.warn(`Proxmox createVM attempt ${attempt}/${maxAttempts}: ${lastFailureDetail}`);
          await rollbackGuest("no disk slot");
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 600)));
            continue;
          }
          this.recordProvisionFailure(lastFailureDetail);
          return false;
        }
        if (!Number.isFinite(diskSize) || diskSize < 1) {
          Logger.error(`Proxmox createVM: invalid diskSizeGb=${diskSize} vmid=${newId}`);
          await rollbackGuest("invalid disk size");
          this.recordProvisionFailure(`invalid diskSizeGb=${diskSize}`);
          return false;
        }

        await this.apiPost(`/nodes/${vmNode}/qemu/${newId}/config`, {
          sockets: 1,
          cores: cpuNumber,
          memory: ramSize * 1024,
          ciuser: "root",
          cipassword: password,
          description: comment,
          net0: this.buildVirtioNet0(networkIn, networkOut),
          ipconfig0: autoIpConfig?.ipconfig0,
          nameserver: autoIpConfig?.nameserver,
        });

        const currentDiskSize = this.parseDiskSizeFromVolume(
          typeof baselineCfg[diskKey] === "string" ? (baselineCfg[diskKey] as string) : undefined
        );
        const currentDiskBytes = this.sizeLiteralToBytes(currentDiskSize);
        const targetDiskBytes = this.sizeLiteralToBytes(`${diskSize}G`);
        const shouldResize =
          targetDiskBytes != null && currentDiskBytes != null
            ? targetDiskBytes > currentDiskBytes
            : true;

        if (shouldResize) {
          try {
            await this.qemuResizeDisk(vmNode, newId, diskKey, `${diskSize}G`);
          } catch (resizeErr) {
            lastFailureDetail = this.extractProxmoxErrorMessage(resizeErr);
            Logger.warn(
              `Proxmox createVM attempt ${attempt}/${maxAttempts}: resize failed vmid=${newId} disk=${diskKey} targetGb=${diskSize}: ${lastFailureDetail}`
            );
            await rollbackGuest("resize failed");
            if (
              attempt < maxAttempts &&
              this.shouldRetryProvisioningAfterError(resizeErr, lastFailureDetail)
            ) {
              await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 600)));
              continue;
            }
            Logger.error(`Proxmox createVM: disk resize failed vmid=${newId} disk=${diskKey} targetGb=${diskSize}`, resizeErr);
            this.recordProvisionFailure(lastFailureDetail);
            return false;
          }
        } else {
          Logger.warn(
            `Proxmox createVM: skip resize shrink vmid=${newId} disk=${diskKey} current=${currentDiskSize ?? "unknown"} target=${diskSize}G`
          );
        }

        await this.apiPost(`/nodes/${vmNode}/qemu/${newId}/status/start`);

        return {
          id: newId,
          task: Date.now(),
          recipe_task_list: [],
          recipe_task: 0,
          spice_task: 0,
        };
      } catch (error) {
        lastFailureDetail = this.extractProxmoxErrorMessage(error);
        Logger.warn(
          `Proxmox createVM attempt ${attempt}/${maxAttempts} failed: ${lastFailureDetail}`,
          error
        );
        await rollbackGuest("exception");
        if (attempt < maxAttempts && this.shouldRetryProvisioningAfterError(error, lastFailureDetail)) {
          await new Promise((r) => setTimeout(r, 600 + Math.floor(Math.random() * 700)));
          continue;
        }
        Logger.error("Proxmox createVM failed", error);
        this.recordProvisionFailure(lastFailureDetail);
        return false;
      }
    }

    Logger.error(`Proxmox createVM exhausted ${maxAttempts} attempts (last: ${lastFailureDetail})`);
    this.recordProvisionFailure(lastFailureDetail || `exhausted ${maxAttempts} attempts`);
    return false;
  }

  /**
   * Find QEMU or LXC guest via cluster index (correct node + virt type).
   */
  private async getClusterVmResource(vmid: number): Promise<ClusterVmRow | undefined> {
    try {
      const resources = await this.apiGet<
        Array<{
          type?: string;
          vmid?: number;
          node?: string;
          status?: string;
          name?: string;
          maxcpu?: number;
          maxmem?: number;
        }>
      >(`/cluster/resources?type=vm`);
      if (!Array.isArray(resources)) return undefined;
      const row = resources.find((r) => Number(r.vmid) === vmid);
      if (!row) return undefined;
      const virtType: ProxmoxGuestKind | undefined =
        row.type === "lxc" ? "lxc" : row.type === "qemu" ? "qemu" : undefined;
      return {
        node: row.node,
        status: row.status,
        name: row.name,
        maxcpu: row.maxcpu,
        maxmem: row.maxmem,
        virtType,
      };
    } catch {
      return undefined;
    }
  }

  /** All joined cluster nodes (cached) — VMs may live on a node different from PROXMOX_NODE. */
  private async listClusterNodeNames(): Promise<string[]> {
    const now = Date.now();
    if (
      this.clusterNodeNamesCache &&
      now - this.clusterNodeNamesCache.at < this.clusterNodeNamesTtlMs
    ) {
      return this.clusterNodeNamesCache.names;
    }
    try {
      const list = await this.apiGet<Array<{ node?: string }>>("/nodes");
      const raw =
        Array.isArray(list)
          ? list.map((n) => String(n.node ?? "").trim()).filter(Boolean)
          : [];
      const names = [...new Set(raw)];
      const resolved =
        names.length > 0 ? names : [this.node].filter((n): n is string => Boolean(n?.trim()));
      this.clusterNodeNamesCache = { names: resolved, at: now };
      return resolved;
    } catch {
      const fallback = [this.node].filter((n): n is string => Boolean(n?.trim()));
      return fallback;
    }
  }

  /**
   * When `/status/current` returns 5xx, match vmid in node-local guest list.
   */
  private async getGuestListFallbackOnNode(
    node: string,
    vmid: number,
    kind: ProxmoxGuestKind
  ): Promise<{ status?: string } | undefined> {
    const seg = kind === "qemu" ? "qemu" : "lxc";
    try {
      const list = await this.apiGet<Array<{ vmid?: number; status?: string; qmpstatus?: string }>>(
        `/nodes/${node}/${seg}`
      );
      const row = Array.isArray(list) ? list.find((v) => Number(v.vmid) === vmid) : undefined;
      if (!row) return undefined;
      const s = String(row.status ?? row.qmpstatus ?? "").toLowerCase();
      if (s === "running") return { status: "running" };
      if (s === "stopped") return { status: "stopped" };
      if (s === "paused") return { status: "stopped" };
      return row.status ? { status: row.status } : undefined;
    } catch {
      return undefined;
    }
  }

  private qemuStatusToListState(status?: string): "active" | "stopped" | "creating" {
    const s = String(status ?? "").toLowerCase();
    if (s === "running") return "active";
    if (s === "stopped" || s === "paused") return "stopped";
    return "creating";
  }

  private async fetchGuestInfoFromNodes(
    vmid: number,
    nodes: string[],
    kind: ProxmoxGuestKind
  ): Promise<{ statusPayload?: { status?: string }; configData?: ProxmoxGuestConfig }> {
    const seg = kind === "qemu" ? "qemu" : "lxc";
    let statusPayload: { status?: string } | undefined;

    for (const node of nodes) {
      const s = await this.apiGet<{ status?: string }>(
        `/nodes/${node}/${seg}/${vmid}/status/current`
      ).catch(() => undefined);
      if (s?.status) {
        statusPayload = s;
        break;
      }
    }

    if (!statusPayload?.status) {
      for (const node of nodes) {
        const fb = await this.getGuestListFallbackOnNode(node, vmid, kind);
        if (fb?.status) {
          Logger.warn(
            `Proxmox getInfoVM: used ${seg} list on node ${node} for guest ${vmid} (status/current unavailable)`
          );
          statusPayload = fb;
          break;
        }
      }
    }

    let configData: ProxmoxGuestConfig | undefined;
    for (const node of nodes) {
      configData = await this.apiGet<ProxmoxGuestConfig>(
        `/nodes/${node}/${seg}/${vmid}/config`
      ).catch(() => undefined);
      if (configData) break;
    }

    return { statusPayload, configData };
  }

  private buildListItemFromGuestParts(
    vmid: number,
    part: { statusPayload?: { status?: string }; configData?: ProxmoxGuestConfig },
    clusterVm?: ClusterVmRow
  ): ListItem {
    const ramFromCluster =
      clusterVm?.maxmem != null && clusterVm.maxmem > 0
        ? Math.round(clusterVm.maxmem / (1024 * 1024))
        : undefined;
    const cfg = part.configData;
    const state = this.qemuStatusToListState(part.statusPayload?.status ?? clusterVm?.status);
    const displayName = cfg?.name ?? cfg?.hostname ?? clusterVm?.name ?? `vm-${vmid}`;
    return {
      id: vmid,
      name: displayName,
      state,
      cpu_number: Number(cfg?.cores ?? clusterVm?.maxcpu ?? 1),
      ram_mib: Number(cfg?.memory ?? ramFromCluster ?? 1024),
    } as ListItem;
  }

  async getInfoVM(id: number): Promise<ListItem | undefined> {
    try {
      const clusterVm = await this.getClusterVmResource(id);
      let nodeCandidates = [
        ...new Set([this.node, clusterVm?.node].filter((n): n is string => Boolean(n?.trim()))),
      ];
      if (nodeCandidates.length === 0) {
        nodeCandidates = await this.listClusterNodeNames();
      }
      if (nodeCandidates.length === 0) {
        return undefined;
      }

      const kindsOrder: ProxmoxGuestKind[] =
        clusterVm?.virtType === "lxc"
          ? ["lxc"]
          : clusterVm?.virtType === "qemu"
            ? ["qemu"]
            : ["qemu", "lxc"];

      const tryKindsOnNodes = async (nodes: string[]): Promise<ListItem | undefined> => {
        const uniq = [...new Set(nodes.filter((n): n is string => Boolean(n?.trim())))];
        if (uniq.length === 0) return undefined;
        for (const kind of kindsOrder) {
          const part = await this.fetchGuestInfoFromNodes(id, uniq, kind);
          if (part.statusPayload?.status || part.configData) {
            return this.buildListItemFromGuestParts(id, part, clusterVm);
          }
        }
        return undefined;
      };

      let item = await tryKindsOnNodes(nodeCandidates);
      if (item) return item;

      const allNodes = await this.listClusterNodeNames();
      const merged = [...new Set([...nodeCandidates, ...allNodes])];
      if (merged.length > nodeCandidates.length) {
        item = await tryKindsOnNodes(merged);
        if (item) return item;
      }

      if (clusterVm && (clusterVm.status || clusterVm.name || clusterVm.maxcpu != null)) {
        Logger.debug(`Proxmox getInfoVM: cluster/resources-only row for guest ${id} (${clusterVm.virtType ?? "?"})`);
        return this.buildListItemFromGuestParts(
          id,
          {
            statusPayload: clusterVm.status ? { status: clusterVm.status } : undefined,
            configData: undefined,
          },
          clusterVm
        );
      }

      Logger.warn(`Proxmox getInfoVM: no status or config for guest ${id} (check token scope / vm exists)`);
      return undefined;
    } catch (error) {
      Logger.error("Proxmox getInfoVM failed", error);
      return undefined;
    }
  }

  async getIpv4AddrVM(id: number): Promise<{ list: Array<{ ip_addr: string }> } | undefined> {
    try {
      const configData = await this.apiGet<{ ipconfig0?: string }>(`/nodes/${this.node}/qemu/${id}/config`).catch(() => undefined);
      const agent = await this.apiGet<{ result?: Array<{ "ip-addresses"?: Array<{ "ip-address"?: string }> }> }>(
        `/nodes/${this.node}/qemu/${id}/agent/network-get-interfaces`
      ).catch(() => null);
      const ips =
        agent?.result
          ?.flatMap((i) => i["ip-addresses"] ?? [])
          .map((ip) => ip["ip-address"] ?? "")
          .filter(
            (ip) =>
              /^\d+\.\d+\.\d+\.\d+$/.test(ip) &&
              ip !== "0.0.0.0" &&
              ip !== "127.0.0.1" &&
              !ip.startsWith("169.254.")
          ) ?? [];
      if (ips.length > 0) return { list: [{ ip_addr: ips[0]! }] };
      const configuredIp = this.parseIpFromIpConfig(configData?.ipconfig0);
      if (configuredIp && configuredIp !== "0.0.0.0" && configuredIp !== "127.0.0.1") {
        return { list: [{ ip_addr: configuredIp }] };
      }
      return { list: [{ ip_addr: "0.0.0.0" }] };
    } catch {
      return { list: [{ ip_addr: "0.0.0.0" }] };
    }
  }

  async addIpv4ToHost(_id: number): Promise<boolean> {
    return false;
  }

  async startVM(id: number): Promise<unknown> {
    const host = (await this.findQemuNodeHostingVmid(id)) ?? this.node;
    return this.apiPost(`/nodes/${host}/qemu/${id}/status/start`);
  }

  async stopVM(id: number): Promise<unknown> {
    const host = (await this.findQemuNodeHostingVmid(id)) ?? this.node;
    return this.apiPost(`/nodes/${host}/qemu/${id}/status/stop`);
  }

  async deleteVM(id: number): Promise<unknown> {
    const host = (await this.findQemuNodeHostingVmid(id)) ?? this.node;
    try {
      return await this.apiDelete(`/nodes/${host}/qemu/${id}?purge=1`);
    } catch (firstError) {
      Logger.warn(`Proxmox direct delete failed for VM ${id}, trying stop+delete`, firstError);
    }

    await this.stopVM(id).catch((stopError) => {
      Logger.warn(`Proxmox stop before delete failed for VM ${id}`, stopError);
    });
    await this.waitForVmStopped(id).catch(() => {});

    const hostAfter = (await this.findQemuNodeHostingVmid(id)) ?? host;
    return this.apiDelete(`/nodes/${hostAfter}/qemu/${id}?purge=1&skiplock=1`);
  }

  async reinstallOS(id: number, osId: number, password?: string, managementDescription?: string): Promise<unknown> {
    const templateId = this.resolveTemplateSourceVmid(osId);
    if (!templateId || templateId === id) {
      Logger.warn(`Proxmox reinstallOS: invalid template for osId=${osId}, templateVmId=${templateId}, guestVmId=${id}`);
      return false;
    }
    const templateKey =
      this.reverseTemplateMap[templateId] ??
      Object.entries(this.templateMap).find(([, v]) => v === templateId)?.[0];
    if (!templateKey || !isVpsLinuxOsKey(templateKey)) {
      Logger.warn(`Proxmox reinstallOS: template is not a Sephora Linux image osId=${osId} vmid=${templateId}`);
      return false;
    }

    const templateNode = await this.findQemuNodeHostingVmid(templateId);
    if (!templateNode) {
      const detail = await this.explainMissingQemuTemplate(templateId);
      this.recordProvisionFailure(detail);
      Logger.error(`Proxmox reinstallOS: template vmid=${templateId} — ${detail}`);
      return false;
    }

    const guestNode = (await this.findQemuNodeHostingVmid(id)) ?? this.node;
    const existingConfig =
      (await this.apiGet<Record<string, unknown>>(`/nodes/${guestNode}/qemu/${id}/config`).catch(() => undefined)) ??
      undefined;
    if (!existingConfig) return false;

    const diskKeyBefore = this.findPrimaryQemuDiskKey(existingConfig);
    const preservedDiskSize =
      diskKeyBefore && typeof existingConfig[diskKeyBefore] === "string"
        ? this.parseDiskSizeFromVolume(existingConfig[diskKeyBefore] as string)
        : undefined;

    const rootPassword = password?.trim() ? password : generatePassword(12);
    const descriptionMerged = [
      managementDescription?.trim(),
      typeof existingConfig.description === "string" ? existingConfig.description.trim() : "",
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 8000);

    try {
      await this.stopVM(id);
      await this.waitForVmStopped(id, 60000).catch(() => {});

      let deleted = false;
      const deletePaths = [
        `/nodes/${guestNode}/qemu/${id}?purge=1&destroy-unreferenced-disks=1&skiplock=1`,
        `/nodes/${guestNode}/qemu/${id}?purge=1&skiplock=1`,
        `/nodes/${guestNode}/qemu/${id}?purge=1`,
        `/nodes/${guestNode}/qemu/${id}`,
      ];
      for (const path of deletePaths) {
        try {
          await this.apiDelete(path);
          deleted = true;
          break;
        } catch (error: any) {
          const msg = String(error?.response?.data?.errors ?? error?.response?.data?.message ?? error?.message ?? "");
          // If VM already vanished between checks, treat as deleted.
          if (msg.toLowerCase().includes("does not exist") || msg.toLowerCase().includes("not found")) {
            deleted = true;
            break;
          }
        }
      }
      if (!deleted) {
        throw new Error(`Proxmox reinstall: failed to delete VM ${id} before clone`);
      }

      const removed = await this.waitUntilQemuGuestAbsent(id, 90000);
      if (!removed) {
        throw new Error(`Proxmox reinstall: VM ${id} still exists after purge`);
      }

      const clonePayload: Record<string, unknown> = {
        newid: id,
        name: (typeof existingConfig.name === "string" && existingConfig.name.trim()) || `vm-${id}`,
        full: 1,
      };
      const storageTrim = this.storage?.trim();
      if (storageTrim) clonePayload.storage = storageTrim;
      if (templateNode !== this.node) {
        clonePayload.target = this.node;
      }

      const cloneResult = await this.apiPost<string>(
        `/nodes/${templateNode}/qemu/${templateId}/clone`,
        clonePayload
      );

      if (typeof cloneResult === "string" && cloneResult.startsWith("UPID:")) {
        const taskOutcome = await this.waitForTaskFinished(templateNode, cloneResult, 600_000);
        if (!taskOutcome.ok) {
          throw new Error(`Proxmox reinstall: clone task failed: ${taskOutcome.detail}`);
        }
      }

      const cloned = await this.waitUntilGuestConfigReadable(id, 180000);
      if (!cloned) {
        throw new Error(`Proxmox reinstall: clone to vmid ${id} never became readable (timeout)`);
      }

      const vmNode = (await this.findQemuNodeHostingVmid(id)) ?? this.node;

      const postCloneCfg =
        (await this.apiGet<Record<string, unknown>>(`/nodes/${vmNode}/qemu/${id}/config`).catch(() => undefined)) ??
        {};
      const diskKeyAfter = this.findPrimaryQemuDiskKey(postCloneCfg);

      const net0Restored =
        typeof existingConfig.net0 === "string" && existingConfig.net0.trim()
          ? existingConfig.net0
          : `virtio,bridge=${this.bridge}`;

      await this.apiPost(`/nodes/${vmNode}/qemu/${id}/config`, {
        sockets: 1,
        cores: Number(existingConfig.cores ?? 1),
        memory: Number(existingConfig.memory ?? 1024),
        ciuser: "root",
        cipassword: rootPassword,
        description: descriptionMerged || "SephoraHost reinstall",
        net0: net0Restored,
        ipconfig0: typeof existingConfig.ipconfig0 === "string" ? existingConfig.ipconfig0 : undefined,
        nameserver: typeof existingConfig.nameserver === "string" ? existingConfig.nameserver : undefined,
      });

      if (preservedDiskSize && diskKeyAfter) {
        try {
          await this.qemuResizeDisk(vmNode, id, diskKeyAfter, preservedDiskSize);
        } catch (resizeErr) {
          Logger.error(
            `Proxmox reinstall: disk resize failed guest=${id} disk=${diskKeyAfter} size=${preservedDiskSize}`,
            resizeErr
          );
          throw resizeErr;
        }
      } else if (preservedDiskSize && !diskKeyAfter) {
        Logger.warn(
          `Proxmox reinstall: preserved disk size ${preservedDiskSize} but could not detect new disk key for guest=${id}`
        );
      }

      await this.apiPost(`/nodes/${vmNode}/qemu/${id}/status/start`);

      return {
        id,
        task: Date.now(),
        recipe_task_list: [],
        recipe_task: 0,
        spice_task: 0,
        _rootPassword: rootPassword !== password?.trim() ? rootPassword : undefined,
      };
    } catch (error) {
      Logger.error(`Proxmox reinstall failed guest=${id} template=${templateId}`, error);
      throw error;
    }
  }

  async changePasswordVM(id: number): Promise<string> {
    const password = generatePassword(12);
    await this.apiPost(`/nodes/${this.node}/qemu/${id}/config`, {
      cipassword: password,
    });
    return password;
  }

  async changePasswordVMCustom(id: number, password: string): Promise<boolean> {
    await this.apiPost(`/nodes/${this.node}/qemu/${id}/config`, {
      cipassword: password,
    });
    return true;
  }

}
