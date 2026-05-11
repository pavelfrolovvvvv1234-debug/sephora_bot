/**
 * Application configuration with environment variable validation.
 * Uses Zod for type-safe validation and clear error messages.
 *
 * @module app/config
 */

import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables (.env wins over stale process env, e.g. PM2)
dotenv.config({ override: true });

/**
 * Zod schema for environment variables validation.
 */
const envSchema = z.object({
  // Telegram Bot Configuration
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  BOT_USERNAME: z.string().min(1, "BOT_USERNAME is required"),
  WEBSITE_URL: z.string().url("WEBSITE_URL must be a valid URL"),
  SUPPORT_USERNAME_TG: z.string().min(1, "SUPPORT_USERNAME_TG is required"),

  // Domain Checker (optional)
  DOMAINR_TOKEN: z.string().optional(),

  // Payment Provider: CrystalPay
  PAYMENT_CRYSTALPAY_ID: z.string().min(1, "PAYMENT_CRYSTALPAY_ID is required"),
  PAYMENT_CRYSTALPAY_SECRET_ONE: z.string().min(1, "PAYMENT_CRYSTALPAY_SECRET_ONE is required"),
  PAYMENT_CRYSTALPAY_SECRET_TWO: z.string().min(1, "PAYMENT_CRYSTALPAY_SECRET_TWO is required"),

  // VMManager API (optional: when omitted, VDS features are disabled)
  VMM_EMAIL: z.string().email("VMM_EMAIL must be a valid email").optional().or(z.literal("")),
  VMM_PASSWORD: z.string().min(1, "VMM_PASSWORD is required").optional().or(z.literal("")),
  VMM_ENDPOINT_URL: z.string().url("VMM_ENDPOINT_URL must be a valid URL").optional().or(z.literal("")),
  VMM_ALLOWED_OS_IDS: z.string().optional(),
  VM_PROVIDER: z.enum(["vmmanager", "proxmox"]).optional().default("vmmanager"),

  // Proxmox API (optional)
  PROXMOX_BASE_URL: z.string().url("PROXMOX_BASE_URL must be a valid URL").optional().or(z.literal("")),
  PROXMOX_NODE: z.string().optional().or(z.literal("")),
  PROXMOX_TOKEN_ID: z.string().optional().or(z.literal("")),
  PROXMOX_TOKEN_SECRET: z.string().optional().or(z.literal("")),
  PROXMOX_STORAGE: z.string().optional().or(z.literal("")),
  PROXMOX_BRIDGE: z.string().optional().or(z.literal("")),
  PROXMOX_TEMPLATE_MAP: z.string().optional().or(z.literal("")),
  PROXMOX_INSECURE_TLS: z.string().optional().or(z.literal("")),

  // Webhook Configuration (optional)
  IS_WEBHOOK: z.string().url().optional().or(z.literal("")),
  PORT_WEBHOOK: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),

  // Optional: comma-separated Telegram user IDs that always have admin access (e.g. "7568177886" or "123,456")
  ADMIN_TELEGRAM_IDS: z.string().optional(),

  // Prime trial: channel for subscription check (bot must be admin). Use ID for private channels or username for public
  PRIME_CHANNEL_ID: z.string().optional(),
  PRIME_CHANNEL_USERNAME: z.string().optional(),
  PRIME_CHANNEL_INVITE: z.string().url().optional().or(z.literal("")),

  // CDN / Proxy service (optional) — Bot API for creating reverse proxies from bot
  CDN_BASE_URL: z.union([z.string().url(), z.literal("")]).optional(),
  CDN_BOT_API_KEY: z.string().optional(),
  CDN_AUTO_TARGET_URL: z.union([z.string().url(), z.literal("")]).optional(),

  // Environment
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

/**
 * Validated environment configuration.
 */
export type Config = z.infer<typeof envSchema>;

/**
 * Validated configuration instance.
 * Will throw if environment variables are invalid.
 */
export const config: Config = (() => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => {
        const path = issue.path.join(".");
        return `  - ${path}: ${issue.message}`;
      });
      console.error("❌ Invalid environment configuration:\n", issues.join("\n"));
      console.error("\nPlease check your .env file and ensure all required variables are set.");
      process.exit(1);
    }
    throw error;
  }
})();

/**
 * Helper to check if webhook mode is enabled.
 */
export const isWebhookMode = (): boolean => {
  return !!config.IS_WEBHOOK && config.IS_WEBHOOK !== "";
};

/**
 * Helper to get webhook port with default.
 */
export const getWebhookPort = (): number => {
  return config.PORT_WEBHOOK ?? 3002;
};

/**
 * Helper to check if running in development mode.
 */
export const isDevelopment = (): boolean => {
  return config.NODE_ENV === "development";
};

/** Parsed list of Telegram user IDs that always have admin access (from ADMIN_TELEGRAM_IDS). */
let _adminTelegramIds: number[] | null = null;

/**
 * Returns Telegram user IDs that are granted admin access via env (ADMIN_TELEGRAM_IDS).
 * Uses validated config so .env is loaded; fallback to process.env for backwards compatibility.
 */
export const getAdminTelegramIds = (): number[] => {
  if (_adminTelegramIds !== null) return _adminTelegramIds;
  const raw = config.ADMIN_TELEGRAM_IDS ?? process.env.ADMIN_TELEGRAM_IDS ?? "";
  _adminTelegramIds = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  return _adminTelegramIds;
};

/**
 * Prime trial: channel identifier for getChatMember (number for private channel ID, string @username for public).
 * Bot must be admin in the channel. Returns null if neither PRIME_CHANNEL_ID nor PRIME_CHANNEL_USERNAME is set.
 */
function trimQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** Whether CDN (proxy) service is configured and available from the bot. */
export const isCdnEnabled = (): boolean => {
  const base = config.CDN_BASE_URL ?? process.env.CDN_BASE_URL ?? "";
  const key = config.CDN_BOT_API_KEY ?? process.env.CDN_BOT_API_KEY ?? "";
  return base.length > 0 && key.length >= 16;
};

/** Default upstream URL for CDN "auto target" button. */
export const getCdnAutoTargetUrl = (): string | null => {
  const raw = (config.CDN_AUTO_TARGET_URL ?? process.env.CDN_AUTO_TARGET_URL ?? "").trim();
  return raw.length > 0 ? raw : null;
};

/** Whether VMManager (and VDS API actions) is configured and available. */
export const isVmManagerEnabled = (): boolean => {
  const email = (config.VMM_EMAIL ?? process.env.VMM_EMAIL ?? "").trim();
  const password = (config.VMM_PASSWORD ?? process.env.VMM_PASSWORD ?? "").trim();
  const endpoint = (config.VMM_ENDPOINT_URL ?? process.env.VMM_ENDPOINT_URL ?? "").trim();

  // Ignore placeholders from .env.example
  const isPlaceholderEmail = email === "your_email@example.com";
  const isPlaceholderPassword = password === "your_vmm_password";
  const isPlaceholderEndpoint = endpoint.includes("your-vmm-endpoint.com");

  return (
    email.length > 0 &&
    password.length > 0 &&
    endpoint.length > 0 &&
    !isPlaceholderEmail &&
    !isPlaceholderPassword &&
    !isPlaceholderEndpoint
  );
};

/** Whether Proxmox provider is selected and minimally configured. */
export const isProxmoxEnabled = (): boolean => {
  const provider = (config.VM_PROVIDER ?? process.env.VM_PROVIDER ?? "vmmanager").trim().toLowerCase();
  if (provider !== "proxmox") return false;
  const baseUrl = (config.PROXMOX_BASE_URL ?? process.env.PROXMOX_BASE_URL ?? "").trim();
  const node = (config.PROXMOX_NODE ?? process.env.PROXMOX_NODE ?? "").trim();
  const tokenId = (config.PROXMOX_TOKEN_ID ?? process.env.PROXMOX_TOKEN_ID ?? "").trim();
  const tokenSecret = (config.PROXMOX_TOKEN_SECRET ?? process.env.PROXMOX_TOKEN_SECRET ?? "").trim();
  return baseUrl.length > 0 && node.length > 0 && tokenId.length > 0 && tokenSecret.length > 0;
};

/** Parse PROXMOX_TEMPLATE_MAP JSON (osKey -> template VMID). Keys should be Linux slugs from VPS_LINUX_OS_KEYS only; each VMID must be a QEMU template used exclusively for Sephora VPS (do not reuse Windows/other-service templates). */
export const getProxmoxTemplateMap = (): Record<string, number> => {
  const raw = (config.PROXMOX_TEMPLATE_MAP ?? process.env.PROXMOX_TEMPLATE_MAP ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(value);
      if (!Number.isNaN(id) && id > 0) out[key] = id;
    }
    return out;
  } catch {
    return {};
  }
};

export const isProxmoxInsecureTls = (): boolean => {
  const raw = (config.PROXMOX_INSECURE_TLS ?? process.env.PROXMOX_INSECURE_TLS ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  // Unset: Proxmox часто на https://IP:8006 с самоподписанным сертификатом — иначе Node даёт "unable to verify the first certificate".
  const baseUrl = (config.PROXMOX_BASE_URL ?? process.env.PROXMOX_BASE_URL ?? "").trim();
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  } catch {
    return false;
  }
  return false;
};

export const getPrimeChannelForCheck = (): number | string | null => {
  const idRaw = trimQuotes(config.PRIME_CHANNEL_ID ?? process.env.PRIME_CHANNEL_ID ?? "");
  const username = trimQuotes(config.PRIME_CHANNEL_USERNAME ?? process.env.PRIME_CHANNEL_USERNAME ?? "");
  if (idRaw) {
    const n = parseInt(idRaw, 10);
    if (!Number.isNaN(n)) {
      // Private channel IDs in Telegram are -100xxxxxxxxxx; if user passed positive short ID, convert
      if (n > 0 && n < 1e10) return -(100 * 1e10 + n);
      return n;
    }
  }
  if (username) {
    return username.startsWith("@") ? username : `@${username}`;
  }
  return null;
};

/**
 * VPS/VDS в меню «Услуги» и «Управление услугами». По умолчанию скрыто.
 * Показать: SHOW_VPS_VDS_IN_MENUS=1 (или true/on/yes).
 */
export const showVpsVdsInServiceMenus = (): boolean => {
  const v = (process.env.SHOW_VPS_VDS_IN_MENUS ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
};

/**
 * Allowed VMManager OS template IDs for VPS/VDS flows.
 * If env is not set, includes project defaults provided by ops.
 */
export const getVmManagerAllowedOsIds = (): Set<number> => {
  const defaults = [920, 921, 922, 923, 924];
  const raw = (config.VMM_ALLOWED_OS_IDS ?? process.env.VMM_ALLOWED_OS_IDS ?? "").trim();
  const parsed = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return new Set(parsed.length > 0 ? parsed : defaults);
};

