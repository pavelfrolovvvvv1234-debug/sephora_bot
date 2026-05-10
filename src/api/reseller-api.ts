import crypto from "crypto";
import { isIPv4 } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import axios, { type AxiosError } from "axios";
import type { Api, RawApi } from "grammy";
import { QueryFailedError, type DataSource, type Repository } from "typeorm";
import { z } from "zod";
import User, { Role, UserStatus } from "../entities/User.js";
import VirtualDedicatedServer, { generatePassword, generateRandomName } from "../entities/VirtualDedicatedServer.js";
import type { ListItem } from "./vmmanager.js";
import type { VmProvider } from "../infrastructure/vmmanager/provider.js";
import { getAdminTelegramIds } from "../app/config.js";
import { retry } from "../shared/utils/retry.js";
import { AppError, ExternalApiError } from "../shared/errors/index.js";
import { buildVdsProxmoxDescriptionLine } from "../shared/vds-proxmox-label.js";

type ResellerAuthInfo = {
  resellerId: string;
  apiKey: string;
  signingSecret: string | null;
  allowedIps: string[];
  webhookUrl: string | null;
  webhookSecret: string | null;
};

type AuthRequest = Request & {
  rawBody?: string;
  resellerAuth?: ResellerAuthInfo;
  requestId?: string;
};

type PricePlan = {
  name: string;
  cpu: number;
  ram: number;
  ssd: number;
  network: number;
  price: {
    bulletproof: number;
    default: number;
  };
};

type ResellerApiOptions = {
  dataSource: DataSource;
  vmProvider: VmProvider;
  botApi: Api<RawApi>;
};

async function getInfoVmResilient(
  vmProvider: VmProvider,
  vmid: number,
  attempts = 4,
  pauseMs = 400
): Promise<ListItem | undefined> {
  let last: ListItem | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await vmProvider.getInfoVM(vmid).catch(() => undefined);
    if (last) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  return last;
}

type WebhookEventType =
  | "service_created"
  | "service_imported"
  | "service_started"
  | "service_stopped"
  | "service_rebooted"
  | "service_password_reset"
  | "service_password_set"
  | "service_renewed"
  | "service_reinstall_started"
  | "service_deleted";

type WebhookPayload = {
  event: WebhookEventType;
  resellerId: string;
  timestamp: string;
  data: Record<string, unknown>;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

const rateLimitStore = new Map<string, RateLimitState>();
const signatureNonceStore = new Map<string, number>();
const idempotencyStore = new Map<string, { bodyHash: string; response: unknown; statusCode: number; expiresAt: number }>();

const createSchema = z.object({
  rateName: z.string().min(1),
  clientExternalId: z.string().min(1).max(128),
  osId: z.number().int().positive().optional(),
  name: z.string().min(1).max(128).optional(),
  displayName: z.string().min(1).max(128).optional(),
});

const importExistingSchema = z.object({
  vmid: z.number().int().positive(),
  rateName: z.string().min(1),
  clientExternalId: z.string().min(1).max(128),
  expireAt: z.string().min(1),
  ip: z.string().min(1).max(64).optional(),
  osId: z.number().int().positive().optional(),
  displayName: z.string().min(1).max(128).optional(),
});

const actionSetPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

const actionRenewSchema = z.object({
  months: z.number().int().positive().optional(),
});

const actionReinstallSchema = z.object({
  osId: z.number().int().positive().optional(),
});

const deleteByIpSchema = z.object({
  ip: z.string().min(1).max(64),
});

function parseBooleanEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function buildOpenApiDoc(baseUrl: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "SephoraHost Reseller API",
      version: "1.0.0",
      description: "Provision and manage reseller VPS services on SephoraHost infrastructure.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/reseller/health": { get: { summary: "Health check", responses: { "200": { description: "OK" } } } },
      "/reseller/v1/services": { get: { summary: "List reseller services", responses: { "200": { description: "OK" } } } },
      "/reseller/v1/services/create": { post: { summary: "Create VPS for reseller client", responses: { "200": { description: "OK" } } } },
      "/reseller/v1/services/import-existing": {
        post: { summary: "Attach existing Proxmox VM to reseller", responses: { "200": { description: "OK" } } },
      },
      "/reseller/v1/services/{id}": { get: { summary: "Get service details", responses: { "200": { description: "OK" } } } },
      "/reseller/v1/services/{id}/actions/{action}": {
        post: { summary: "Execute service action", responses: { "200": { description: "OK" } } },
      },
    },
  } as const;
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> {
  const source = (raw ?? "").trim();
  if (!source) return {};
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getResellerKeysMap(): Record<string, string> {
  const parsed = parseJsonRecord(process.env.RESELLER_API_KEYS_JSON);
  const out: Record<string, string> = {};
  for (const [resellerId, keyValue] of Object.entries(parsed)) {
    const key = String(keyValue ?? "").trim();
    if (resellerId.trim() && key.length >= 12) {
      out[resellerId.trim()] = key;
    }
  }
  return out;
}

function getResellerSigningSecretsMap(): Record<string, string> {
  const parsed = parseJsonRecord(process.env.RESELLER_API_SIGNING_SECRETS_JSON);
  const out: Record<string, string> = {};
  for (const [resellerId, secretValue] of Object.entries(parsed)) {
    const secret = String(secretValue ?? "").trim();
    if (resellerId.trim() && secret.length >= 12) {
      out[resellerId.trim()] = secret;
    }
  }
  return out;
}

function getResellerAllowedIpsMap(): Record<string, string[]> {
  const parsed = parseJsonRecord(process.env.RESELLER_API_ALLOWED_IPS_JSON);
  const out: Record<string, string[]> = {};
  for (const [resellerId, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      out[resellerId.trim()] = value.map((x) => String(x).trim()).filter(Boolean);
    } else if (typeof value === "string") {
      out[resellerId.trim()] = value
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function getResellerWebhooksMap(): Record<string, string> {
  const parsed = parseJsonRecord(process.env.RESELLER_WEBHOOKS_JSON);
  const out: Record<string, string> = {};
  for (const [resellerId, urlValue] of Object.entries(parsed)) {
    const url = String(urlValue ?? "").trim();
    if (resellerId.trim() && url.startsWith("http")) {
      out[resellerId.trim()] = url;
    }
  }
  return out;
}

function getResellerWebhookSecretsMap(): Record<string, string> {
  const parsed = parseJsonRecord(process.env.RESELLER_WEBHOOK_SECRETS_JSON);
  const out: Record<string, string> = {};
  for (const [resellerId, secretValue] of Object.entries(parsed)) {
    const secret = String(secretValue ?? "").trim();
    if (resellerId.trim() && secret.length >= 12) {
      out[resellerId.trim()] = secret;
    }
  }
  return out;
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildSignature(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getClientIp(req: Request): string {
  const forwarded = String(req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)[0];
  const candidate = forwarded || req.ip || req.socket.remoteAddress || "";
  return candidate.replace(/^::ffff:/, "");
}

function requireResellerAuth(
  keysMap: Record<string, string>,
  signingSecretsMap: Record<string, string>,
  allowedIpsMap: Record<string, string[]>,
  webhookMap: Record<string, string>,
  webhookSecrets: Record<string, string>
) {
  const keyToReseller = new Map<string, string>();
  for (const [resellerId, key] of Object.entries(keysMap)) {
    keyToReseller.set(key, resellerId);
  }

  const maxSkewSeconds = Number.parseInt(process.env.RESELLER_API_MAX_SKEW_SECONDS ?? "300", 10) || 300;

  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const apiKey = String(req.header("x-api-key") ?? "").trim();
    if (!apiKey) {
      res.status(401).json({ ok: false, error: "missing_api_key" });
      return;
    }
    const resellerId = keyToReseller.get(apiKey);
    if (!resellerId) {
      res.status(403).json({ ok: false, error: "invalid_api_key" });
      return;
    }

    const allowedIps = allowedIpsMap[resellerId] ?? [];
    if (allowedIps.length > 0) {
      const clientIp = getClientIp(req);
      if (!allowedIps.includes(clientIp)) {
        res.status(403).json({ ok: false, error: "ip_not_allowed" });
        return;
      }
    }

    const signingSecret = signingSecretsMap[resellerId] ?? null;
    if (signingSecret) {
      const timestamp = String(req.header("x-timestamp") ?? "").trim();
      const signature = String(req.header("x-signature") ?? "").trim();
      const nonce = String(req.header("x-nonce") ?? "").trim();
      if (!timestamp || !signature) {
        res.status(401).json({ ok: false, error: "missing_signature_headers" });
        return;
      }
      if (!nonce) {
        res.status(401).json({ ok: false, error: "missing_nonce_header" });
        return;
      }
      const ts = Number.parseInt(timestamp, 10);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkewSeconds) {
        res.status(401).json({ ok: false, error: "signature_timestamp_out_of_range" });
        return;
      }
      const rawBody = req.rawBody ?? "";
      const expected = buildSignature(signingSecret, timestamp, rawBody);
      if (!secureEqual(expected, signature)) {
        res.status(401).json({ ok: false, error: "invalid_signature" });
        return;
      }
      const nonceKey = `${resellerId}:${nonce}:${timestamp}`;
      if (signatureNonceStore.has(nonceKey)) {
        res.status(409).json({ ok: false, error: "nonce_already_used" });
        return;
      }
      signatureNonceStore.set(nonceKey, Date.now() + maxSkewSeconds * 1000);
    }

    req.resellerAuth = {
      resellerId,
      apiKey,
      signingSecret,
      allowedIps,
      webhookUrl: webhookMap[resellerId] ?? null,
      webhookSecret: webhookSecrets[resellerId] ?? null,
    };
    next();
  };
}

function requireRateLimit(req: AuthRequest, res: Response, next: NextFunction): void {
  const resellerId = req.resellerAuth?.resellerId;
  if (!resellerId) {
    res.status(500).json({ ok: false, error: "missing_reseller_context" });
    return;
  }
  const windowSec = Number.parseInt(process.env.RESELLER_API_RATE_WINDOW_SEC ?? "60", 10) || 60;
  const maxReq = Number.parseInt(process.env.RESELLER_API_RATE_MAX ?? "120", 10) || 120;
  const now = Date.now();
  const state = rateLimitStore.get(resellerId);
  if (!state || now >= state.resetAt) {
    rateLimitStore.set(resellerId, { count: 1, resetAt: now + windowSec * 1000 });
    next();
    return;
  }
  if (state.count >= maxReq) {
    const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ ok: false, error: "rate_limit_exceeded", retryAfterSec: retryAfter });
    return;
  }
  state.count += 1;
  next();
}

function requestMeta(req: AuthRequest): { requestId: string } {
  return { requestId: req.requestId || "n/a" };
}

function withRequestId(req: AuthRequest, res: Response, next: NextFunction): void {
  const incoming = String(req.header("x-request-id") ?? "").trim();
  const requestId = incoming || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

function cleanupSecurityCaches(): void {
  const now = Date.now();
  for (const [k, exp] of signatureNonceStore.entries()) {
    if (now >= exp) signatureNonceStore.delete(k);
  }
  for (const [k, entry] of idempotencyStore.entries()) {
    if (now >= entry.expiresAt) idempotencyStore.delete(k);
  }
}

function checkIdempotency(req: AuthRequest): { hit: boolean; statusCode?: number; response?: unknown } | { hit: false; conflict: true } {
  const key = String(req.header("x-idempotency-key") ?? "").trim();
  if (!key || !req.resellerAuth) return { hit: false };
  const resellerId = req.resellerAuth.resellerId;
  const storeKey = `${resellerId}:${req.method}:${req.path}:${key}`;
  const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
  const bodyHash = sha256Hex(rawBody);
  const existing = idempotencyStore.get(storeKey);
  if (!existing) return { hit: false };
  if (existing.bodyHash !== bodyHash) return { hit: false, conflict: true };
  return { hit: true, statusCode: existing.statusCode, response: existing.response };
}

function saveIdempotency(req: AuthRequest, statusCode: number, response: unknown): void {
  const key = String(req.header("x-idempotency-key") ?? "").trim();
  if (!key || !req.resellerAuth) return;
  const ttlSec = Number.parseInt(process.env.RESELLER_API_IDEMPOTENCY_TTL_SEC ?? "3600", 10) || 3600;
  const resellerId = req.resellerAuth.resellerId;
  const storeKey = `${resellerId}:${req.method}:${req.path}:${key}`;
  const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
  const bodyHash = sha256Hex(rawBody);
  idempotencyStore.set(storeKey, {
    bodyHash,
    statusCode,
    response,
    expiresAt: Date.now() + ttlSec * 1000,
  });
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "body"}: ${issue?.message || "invalid_payload"}` };
  }
  return { ok: true, data: parsed.data };
}

function getPlansMap(): Map<string, PricePlan> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prices = require("../prices.json") as { virtual_vds: PricePlan[] };
  return new Map(prices.virtual_vds.map((p) => [p.name.toLowerCase(), p]));
}

function parseMonthsToDays(months: number): number {
  if (![1, 3, 6, 12].includes(months)) return 30;
  return months * 30;
}

function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parsePositiveIntEnv(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const msg = String(err.message ?? "");
  return /unique|UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}

/** Poll hypervisor until VM has a real IPv4 (same idea as vds-shop-flow). */
async function pollResellerVmIpv4(vmProvider: VmProvider, vmid: number): Promise<string> {
  const maxAttempts = parsePositiveIntEnv("RESELLER_VDS_IP_POLL_MAX_ATTEMPTS", 20);
  const delayMs = parsePositiveIntEnv("RESELLER_VDS_IP_POLL_MS", 2000);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ipData = await vmProvider.getIpv4AddrVM(vmid).catch(() => undefined);
    const candidate = ipData?.list?.[0]?.ip_addr;
    if (candidate && candidate !== "0.0.0.0" && candidate !== "127.0.0.1") {
      return candidate;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const last = await vmProvider.getIpv4AddrVM(vmid).catch(() => undefined);
  return last?.list?.[0]?.ip_addr ?? "0.0.0.0";
}

function stableNegativeId(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  const abs = Math.abs(hash || 1);
  return -abs;
}

async function getOrCreateClientUser(
  dataSource: DataSource,
  resellerId: string,
  clientExternalId: string
): Promise<User> {
  const userRepo = dataSource.getRepository(User);
  const syntheticTelegramId = stableNegativeId(`${resellerId}:${clientExternalId}`);
  let user = await userRepo.findOneBy({ telegramId: syntheticTelegramId });
  if (user) return user;
  user = userRepo.create({
    telegramId: syntheticTelegramId,
    role: Role.User,
    status: UserStatus.User,
    lang: "en",
    isBanned: false,
    balance: 0,
    referralBalance: 0,
  });
  return await userRepo.save(user);
}

/** Env allowlist + admins/moderators from DB (same staff who see admin menus). */
async function getResellerAlertRecipientTelegramIds(dataSource: DataSource): Promise<number[]> {
  const fromEnv = getAdminTelegramIds();
  const repo = dataSource.getRepository(User);
  const staff = await repo.find({
    where: [{ role: Role.Admin }, { role: Role.Moderator }],
    select: ["telegramId"],
  });
  const fromDb = staff
    .map((u) => Number(u.telegramId))
    .filter((id) => Number.isFinite(id) && id > 0);
  return [...new Set([...fromEnv, ...fromDb])];
}

function mapService(vds: VirtualDedicatedServer) {
  return {
    serviceId: vds.id,
    vmid: vds.vdsId,
    resellerId: vds.resellerId,
    resellerClientId: vds.resellerClientId,
    rateName: vds.rateName,
    ip: vds.ipv4Addr,
    login: vds.login,
    expireAt: vds.expireAt,
    autoRenewEnabled: vds.autoRenewEnabled !== false,
    isBlocked: vds.adminBlocked || vds.managementLocked,
    createdAt: vds.createdAt,
    updatedAt: vds.lastUpdateAt,
  };
}

async function emitWebhook(auth: ResellerAuthInfo, payload: WebhookPayload): Promise<void> {
  if (!auth.webhookUrl) return;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-reseller-id": auth.resellerId,
  };
  if (auth.webhookSecret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-timestamp"] = ts;
    headers["x-signature"] = buildSignature(auth.webhookSecret, ts, body);
  }
  await axios.post(auth.webhookUrl, payload, { headers, timeout: 10000 }).catch(() => {});
}

function normalizeResellerIpv4(raw: string): string | null {
  const t = raw.trim();
  if (!isIPv4(t)) return null;
  return t;
}

async function performResellerServiceDelete(
  options: ResellerApiOptions,
  auth: ResellerAuthInfo,
  resellerId: string,
  vds: VirtualDedicatedServer,
  vdsRepo: Repository<VirtualDedicatedServer>,
  req: AuthRequest,
  res: Response
): Promise<void> {
  const itemSnapshot = mapService(vds);
  try {
    await retry(() => options.vmProvider.deleteVM(vds.vdsId), {
      maxAttempts: 3,
      delayMs: 2000,
      exponentialBackoff: true,
    });
  } catch {
    res.status(502).json({ ok: false, error: "delete_failed", ...requestMeta(req) });
    return;
  }
  await vdsRepo.delete({ id: vds.id });
  await emitWebhook(auth, {
    event: "service_deleted",
    resellerId,
    timestamp: new Date().toISOString(),
    data: itemSnapshot,
  });
  res.json({
    ok: true,
    deleted: { serviceId: vds.id, vmid: vds.vdsId, ip: vds.ipv4Addr },
  });
}

async function notifyAdminsAboutResellerVps(
  options: ResellerApiOptions,
  payload: {
    action: "created" | "imported";
    resellerId: string;
    clientExternalId: string;
    vds: VirtualDedicatedServer;
    login: string;
    password: string;
  }
): Promise<void> {
  const adminIds = await getResellerAlertRecipientTelegramIds(options.dataSource);
  if (adminIds.length === 0) return;

  const price = Number(payload.vds.renewalPrice || 0);
  const text = [
    `🧩 <b>Reseller VPS ${payload.action === "created" ? "purchase" : "import"}</b>`,
    ``,
    `🏷 <b>Reseller:</b> ${payload.resellerId}`,
    `👤 <b>Client:</b> ${payload.clientExternalId}`,
    `🖥 <b>Service ID:</b> ${payload.vds.id}`,
    `🆔 <b>VMID:</b> ${payload.vds.vdsId}`,
    `🌍 <b>IP:</b> ${payload.vds.ipv4Addr || "0.0.0.0"}`,
    `📦 <b>Plan:</b> ${payload.vds.rateName}`,
    `💰 <b>Cost:</b> $${price.toFixed(2)} / 30d`,
    `📅 <b>Expires:</b> ${new Date(payload.vds.expireAt).toISOString()}`,
    ``,
    `🔐 <b>Access:</b>`,
    `👤 Login: <code>${payload.login}</code>`,
    `🔑 Password: <code>${payload.password}</code>`,
    ``,
    `⚙️ <b>Resources:</b> CPU ${payload.vds.cpuCount} | RAM ${payload.vds.ramSize}GB | Disk ${payload.vds.diskSize}GB | Net ${payload.vds.networkSpeed}Mbps`,
  ].join("\n");

  await Promise.all(
    adminIds.map((adminId) =>
      options.botApi
        .sendMessage(adminId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {})
    )
  );
}

function unwrapAxiosFromChain(err: unknown): AxiosError | undefined {
  if (axios.isAxiosError(err)) return err;
  if (err instanceof ExternalApiError && err.originalError !== undefined) {
    return unwrapAxiosFromChain(err.originalError);
  }
  return undefined;
}

/** Safe excerpt from VMManager / Proxmox HTTP response for reseller diagnostics. */
function describeUpstreamFailure(err: unknown): { upstreamStatus?: number; upstreamDetail?: string } {
  const ax = unwrapAxiosFromChain(err);
  if (!ax?.response) return {};
  const status = ax.response.status;
  const data = ax.response.data as unknown;
  let upstreamDetail: string | undefined;
  if (data !== undefined && data !== null) {
    if (typeof data === "string") upstreamDetail = data.slice(0, 1200);
    else {
      try {
        upstreamDetail = JSON.stringify(data).slice(0, 1200);
      } catch {
        upstreamDetail = undefined;
      }
    }
  }
  return { upstreamStatus: status, upstreamDetail };
}

function clientCodeForAppError(err: AppError): string {
  if (err.code === "EXTERNAL_API_ERROR") return "upstream_error";
  return err.code.toLowerCase();
}

async function routeGuarded(req: AuthRequest, res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error: unknown) {
    if (error instanceof AppError) {
      const payload: Record<string, unknown> = {
        ok: false,
        error: clientCodeForAppError(error),
        ...requestMeta(req),
      };
      if (error.code === "EXTERNAL_API_ERROR") {
        Object.assign(payload, describeUpstreamFailure(error));
      }
      if (process.env.NODE_ENV !== "production" && error.message) {
        payload.message = error.message;
      }
      res.status(error.statusCode).json(payload);
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: process.env.NODE_ENV === "production" ? "internal_error" : msg || "internal_error",
      ...requestMeta(req),
    });
  }
}

export function startResellerApiServer(options: ResellerApiOptions): void {
  const enabled = parseBooleanEnv(process.env.RESELLER_API_ENABLED);
  const keysMap = getResellerKeysMap();
  if (!enabled || Object.keys(keysMap).length === 0) return;

  const signingSecretsMap = getResellerSigningSecretsMap();
  const allowedIpsMap = getResellerAllowedIpsMap();
  const webhookMap = getResellerWebhooksMap();
  const webhookSecrets = getResellerWebhookSecretsMap();

  const app = express();
  app.set("trust proxy", true);
  app.use(withRequestId);
  app.use(
    express.json({
      verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as AuthRequest).rawBody = buf.toString("utf8");
      },
    })
  );

  app.get("/reseller/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "reseller-api" });
  });

  app.get("/reseller/openapi.json", (req: Request, res: Response) => {
    const host = req.header("host") || `localhost:${process.env.RESELLER_API_PORT ?? "3003"}`;
    const proto = (req.header("x-forwarded-proto") || req.protocol || "https").toString();
    res.json(buildOpenApiDoc(`${proto}://${host}`));
  });

  app.get("/reseller/docs", (_req: Request, res: Response) => {
    res.type("text/plain").send(
      [
        "SephoraHost Reseller API docs:",
        "1) OpenAPI JSON: /reseller/openapi.json",
        "2) Endpoints base: /reseller/v1/*",
        "3) Auth: x-api-key (+ optional HMAC headers)",
      ].join("\n")
    );
  });

  app.use(
    "/reseller/v1",
    requireResellerAuth(keysMap, signingSecretsMap, allowedIpsMap, webhookMap, webhookSecrets),
    requireRateLimit
  );

  app.get("/reseller/v1/services", async (req: AuthRequest, res: Response) => {
    await routeGuarded(req, res, async () => {
      const resellerId = req.resellerAuth!.resellerId;
      const vdsRepo = options.dataSource.getRepository(VirtualDedicatedServer);
      const services = await vdsRepo.find({
        where: { resellerId },
        order: { id: "DESC" },
        take: 500,
      });
      res.json({ ok: true, items: services.map(mapService) });
    });
  });

  app.post("/reseller/v1/services/import-existing", async (req: AuthRequest, res: Response) => {
    await routeGuarded(req, res, async () => {
      cleanupSecurityCaches();
      const idem = checkIdempotency(req);
      if ("conflict" in idem) {
        res.status(409).json({ ok: false, error: "idempotency_key_body_mismatch", ...requestMeta(req) });
        return;
      }
      if (idem.hit) {
        res.status(idem.statusCode || 200).json({ ...(idem.response as object), ...requestMeta(req), idempotentReplay: true });
        return;
      }

      const bodyParsed = parseBody(importExistingSchema, req.body);
      if (!bodyParsed.ok) {
        res.status(400).json({ ok: false, error: bodyParsed.error, ...requestMeta(req) });
        return;
      }
      const body = bodyParsed.data;
      const auth = req.resellerAuth!;
      const resellerId = auth.resellerId;
      const vmid = body.vmid;
      const rateName = body.rateName.trim();
      const clientExternalId = body.clientExternalId.trim();
      const expiresAtRaw = body.expireAt.trim();

      if (!vmid || !rateName || !clientExternalId || !expiresAtRaw) {
        res.status(400).json({ ok: false, error: "vmid, rateName, clientExternalId, expireAt are required" });
        return;
      }

      const plansMap = getPlansMap();
      const plan = plansMap.get(rateName.toLowerCase());
      if (!plan) {
        res.status(400).json({ ok: false, error: "unknown_rate_name" });
        return;
      }

      const expireAt = new Date(expiresAtRaw);
      if (Number.isNaN(expireAt.getTime())) {
        res.status(400).json({ ok: false, error: "invalid_expireAt" });
        return;
      }

      const clientUser = await getOrCreateClientUser(options.dataSource, resellerId, clientExternalId);
      const vdsRepo = options.dataSource.getRepository(VirtualDedicatedServer);
      const existing = await vdsRepo.findOneBy({ vdsId: vmid });
      const password = generatePassword(12);
      await options.vmProvider.changePasswordVMCustom(vmid, password).catch(() => {});

      const entity = existing ?? vdsRepo.create();
      entity.vdsId = vmid;
      entity.login = "root";
      entity.password = password;
      entity.ipv4Addr = String(body.ip ?? "0.0.0.0");
      entity.cpuCount = plan.cpu;
      entity.networkSpeed = plan.network;
      entity.isBulletproof = true;
      entity.payDayAt = null;
      entity.ramSize = plan.ram;
      entity.diskSize = plan.ssd;
      entity.lastOsId = body.osId ?? 900;
      entity.rateName = plan.name;
      entity.expireAt = expireAt;
      entity.targetUserId = clientUser.id;
      entity.renewalPrice = Number(plan.price.bulletproof || plan.price.default || 0);
      entity.displayName = String(body.displayName ?? clientExternalId);
      entity.bundleType = null;
      entity.autoRenewEnabled = true;
      entity.adminBlocked = false;
      entity.managementLocked = false;
      entity.extraIpv4Count = 0;
      entity.resellerId = resellerId;
      entity.resellerClientId = clientExternalId;

      const saved = await vdsRepo.save(entity);
      const mapped = mapService(saved);
      await notifyAdminsAboutResellerVps(options, {
        action: "imported",
        resellerId,
        clientExternalId,
        vds: saved,
        login: "root",
        password,
      });
      await emitWebhook(auth, {
        event: "service_imported",
        resellerId,
        timestamp: new Date().toISOString(),
        data: mapped,
      });
      const response = { ok: true, item: mapped, credentials: { login: "root", password }, ...requestMeta(req) };
      saveIdempotency(req, 200, response);
      res.json(response);
    });
  });

  app.post("/reseller/v1/services/create", async (req: AuthRequest, res: Response) => {
    await routeGuarded(req, res, async () => {
      cleanupSecurityCaches();
      const idem = checkIdempotency(req);
      if ("conflict" in idem) {
        res.status(409).json({ ok: false, error: "idempotency_key_body_mismatch", ...requestMeta(req) });
        return;
      }
      if (idem.hit) {
        res.status(idem.statusCode || 200).json({ ...(idem.response as object), ...requestMeta(req), idempotentReplay: true });
        return;
      }

      const bodyParsed = parseBody(createSchema, req.body);
      if (!bodyParsed.ok) {
        res.status(400).json({ ok: false, error: bodyParsed.error, ...requestMeta(req) });
        return;
      }
      const body = bodyParsed.data;
      const auth = req.resellerAuth!;
      const resellerId = auth.resellerId;
      const rateName = body.rateName.trim();
      const clientExternalId = body.clientExternalId.trim();
      if (!rateName || !clientExternalId) {
        res.status(400).json({ ok: false, error: "rateName and clientExternalId are required" });
        return;
      }

      const plansMap = getPlansMap();
      const plan = plansMap.get(rateName.toLowerCase());
      if (!plan) {
        res.status(400).json({ ok: false, error: "unknown_rate_name" });
        return;
      }

      const osId = body.osId ?? 900;
      const password = generatePassword(12);
      const name = String(body.name ?? generateRandomName(13));
      const vm = await options.vmProvider.createVM(
        name,
        password,
        plan.cpu,
        plan.ram,
        osId,
        `Reseller:${resellerId},Client:${clientExternalId},Plan:${plan.name}`,
        plan.ssd,
        1,
        plan.network,
        plan.network
      );
      if (!vm) {
        res.status(502).json({ ok: false, error: "vm_create_failed" });
        return;
      }

      const vmid = vm.id;
      const vdsRepo = options.dataSource.getRepository(VirtualDedicatedServer);
      const existingByVmid = await vdsRepo.findOneBy({ vdsId: vmid });
      if (existingByVmid) {
        res.status(409).json({
          ok: false,
          error: "vmid_already_registered",
          vmid,
          ...requestMeta(req),
        });
        return;
      }

      const ip = await pollResellerVmIpv4(options.vmProvider, vmid);
      const clientUser = await getOrCreateClientUser(options.dataSource, resellerId, clientExternalId);
      const entity = vdsRepo.create({
        vdsId: vmid,
        login: "root",
        password,
        ipv4Addr: ip,
        cpuCount: plan.cpu,
        networkSpeed: plan.network,
        isBulletproof: true,
        payDayAt: null,
        ramSize: plan.ram,
        diskSize: plan.ssd,
        lastOsId: osId,
        rateName: plan.name,
        expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        targetUserId: clientUser.id,
        renewalPrice: Number(plan.price.bulletproof || plan.price.default || 0),
        displayName: String(body.displayName ?? clientExternalId),
        bundleType: null,
        autoRenewEnabled: true,
        adminBlocked: false,
        managementLocked: false,
        extraIpv4Count: 0,
        resellerId,
        resellerClientId: clientExternalId,
      });
      let saved: VirtualDedicatedServer;
      try {
        saved = await vdsRepo.save(entity);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          res.status(409).json({
            ok: false,
            error: "vmid_duplicate",
            vmid,
            ...requestMeta(req),
          });
          return;
        }
        throw err;
      }
      const mapped = mapService(saved);
      await notifyAdminsAboutResellerVps(options, {
        action: "created",
        resellerId,
        clientExternalId,
        vds: saved,
        login: "root",
        password,
      });
      await emitWebhook(auth, {
        event: "service_created",
        resellerId,
        timestamp: new Date().toISOString(),
        data: mapped,
      });
      const response = { ok: true, item: mapped, credentials: { login: "root", password }, ...requestMeta(req) };
      saveIdempotency(req, 200, response);
      res.json(response);
    });
  });

  app.post("/reseller/v1/services/delete-by-ip", async (req: AuthRequest, res: Response) => {
    await routeGuarded(req, res, async () => {
      const bodyParsed = parseBody(deleteByIpSchema, req.body);
      if (!bodyParsed.ok) {
        res.status(400).json({ ok: false, error: bodyParsed.error, ...requestMeta(req) });
        return;
      }
      const ipNorm = normalizeResellerIpv4(bodyParsed.data.ip);
      if (!ipNorm || ipNorm === "0.0.0.0") {
        res.status(400).json({ ok: false, error: "invalid_ip", ...requestMeta(req) });
        return;
      }
      const auth = req.resellerAuth!;
      const resellerId = auth.resellerId;
      const vdsRepo = options.dataSource.getRepository(VirtualDedicatedServer);
      const matches = await vdsRepo.find({
        where: { resellerId, ipv4Addr: ipNorm },
        take: 2,
      });
      if (matches.length === 0) {
        res.status(404).json({ ok: false, error: "service_not_found", ...requestMeta(req) });
        return;
      }
      if (matches.length > 1) {
        res.status(409).json({ ok: false, error: "ambiguous_ip", ...requestMeta(req) });
        return;
      }
      await performResellerServiceDelete(options, auth, resellerId, matches[0]!, vdsRepo, req, res);
    });
  });

  app.get("/reseller/v1/services/:id", async (req: AuthRequest, res: Response) => {
    await routeGuarded(req, res, async () => {
      const resellerId = req.resellerAuth!.resellerId;
      const serviceId = parsePositiveInt(req.params.id);
      if (!serviceId) {
        res.status(400).json({ ok: false, error: "invalid_service_id" });
        return;
      }
      const vdsRepo = options.dataSource.getRepository(VirtualDedicatedServer);
      const vds = await vdsRepo.findOneBy({ id: serviceId, resellerId });
      if (!vds) {
        res.status(404).json({ ok: false, error: "service_not_found" });
        return;
      }
      const info = await getInfoVmResilient(options.vmProvider, vds.vdsId);
      res.json({
        ok: true,
        item: {
          ...mapService(vds),
          vmState: info?.state ?? "unknown",
          vmCpu: info?.cpu_number ?? null,
          vmRamMib: info?.ram_mib ?? null,
        },
      });
    });
  });

  app.post("/reseller/v1/services/:id/actions/:action", async (req: AuthRequest, res: Response) => {
    await routeGuarded(req, res, async () => {
      const auth = req.resellerAuth!;
      const resellerId = auth.resellerId;
      const serviceId = parsePositiveInt(req.params.id);
      const action = String(req.params.action ?? "").trim().toLowerCase();
      if (!serviceId) {
        res.status(400).json({ ok: false, error: "invalid_service_id" });
        return;
      }
      const vdsRepo = options.dataSource.getRepository(VirtualDedicatedServer);
      const vds = await vdsRepo.findOneBy({ id: serviceId, resellerId });
      if (!vds) {
        res.status(404).json({ ok: false, error: "service_not_found" });
        return;
      }

      const emit = async (event: WebhookEventType, extra?: Record<string, unknown>) => {
        await emitWebhook(auth, {
          event,
          resellerId,
          timestamp: new Date().toISOString(),
          data: { ...mapService(vds), ...(extra ?? {}) },
        });
      };

      if (action === "start") {
        await options.vmProvider.startVM(vds.vdsId);
        await emit("service_started");
        res.json({ ok: true });
        return;
      }
      if (action === "stop") {
        await options.vmProvider.stopVM(vds.vdsId);
        await emit("service_stopped");
        res.json({ ok: true });
        return;
      }
      if (action === "reboot") {
        await options.vmProvider.stopVM(vds.vdsId);
        await options.vmProvider.startVM(vds.vdsId);
        await emit("service_rebooted");
        res.json({ ok: true });
        return;
      }
      if (action === "reset-password") {
        const password = await options.vmProvider.changePasswordVM(vds.vdsId);
        vds.password = password;
        await vdsRepo.save(vds);
        await emit("service_password_reset");
        res.json({ ok: true, credentials: { login: "root", password } });
        return;
      }
      if (action === "set-password") {
        const bodyParsed = parseBody(actionSetPasswordSchema, req.body);
        if (!bodyParsed.ok) {
          res.status(400).json({ ok: false, error: bodyParsed.error, ...requestMeta(req) });
          return;
        }
        const password = bodyParsed.data.password;
        const ok = await options.vmProvider.changePasswordVMCustom(vds.vdsId, password);
        if (!ok) {
          res.status(502).json({ ok: false, error: "password_set_failed" });
          return;
        }
        vds.password = password;
        await vdsRepo.save(vds);
        await emit("service_password_set");
        res.json({ ok: true });
        return;
      }
      if (action === "renew") {
        const bodyParsed = parseBody(actionRenewSchema, req.body ?? {});
        if (!bodyParsed.ok) {
          res.status(400).json({ ok: false, error: bodyParsed.error, ...requestMeta(req) });
          return;
        }
        const months = bodyParsed.data.months ?? 1;
        const days = parseMonthsToDays(months);
        const base = Math.max(Date.now(), new Date(vds.expireAt).getTime());
        vds.expireAt = new Date(base + days * 24 * 60 * 60 * 1000);
        vds.payDayAt = null;
        vds.managementLocked = false;
        await vdsRepo.save(vds);
        await emit("service_renewed", { months });
        res.json({ ok: true, item: mapService(vds) });
        return;
      }
      if (action === "reinstall") {
        const bodyParsed = parseBody(actionReinstallSchema, req.body ?? {});
        if (!bodyParsed.ok) {
          res.status(400).json({ ok: false, error: bodyParsed.error, ...requestMeta(req) });
          return;
        }
        const osId = bodyParsed.data.osId ?? (vds.lastOsId || 900);
        const rootPw = vds.password?.trim() || generatePassword(12);
        let result: unknown;
        try {
          result = await options.vmProvider.reinstallOS(
            vds.vdsId,
            osId,
            rootPw,
            buildVdsProxmoxDescriptionLine(vds)
          );
        } catch {
          res.status(502).json({ ok: false, error: "reinstall_failed" });
          return;
        }
        if (!result) {
          res.status(502).json({ ok: false, error: "reinstall_failed" });
          return;
        }
        if (
          typeof result === "object" &&
          result !== null &&
          "_rootPassword" in result &&
          typeof (result as { _rootPassword?: string })._rootPassword === "string"
        ) {
          const np = (result as { _rootPassword: string })._rootPassword;
          if (np) vds.password = np;
        } else {
          vds.password = rootPw;
        }
        vds.lastOsId = osId;
        await vdsRepo.save(vds);
        await emit("service_reinstall_started", { osId });
        res.json({ ok: true });
        return;
      }
      if (action === "delete") {
        await performResellerServiceDelete(options, auth, resellerId, vds, vdsRepo, req, res);
        return;
      }

      res.status(400).json({ ok: false, error: "unknown_action" });
    });
  });

  const port = Number.parseInt(process.env.RESELLER_API_PORT ?? "3003", 10) || 3003;
  app.listen(port, () => {
    console.log(`[Reseller API] listening on :${port}`);
  });
}
