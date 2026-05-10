/**
 * Client for CDN / proxy-service Bot API.
 * Used to create reverse proxies and list them by Telegram user ID.
 *
 * @module infrastructure/cdn/CdnClient
 */

const getBaseUrl = (): string => {
  const url = process.env.CDN_BASE_URL ?? "";
  return String(url).replace(/\/$/, "");
};

const getApiKey = (): string => {
  return process.env.CDN_BOT_API_KEY ?? "";
};

export interface CdnPriceResponse {
  success: boolean;
  data?: { price: number; currency: string };
  error?: string;
}

export interface CdnCreateProxyResponse {
  success: boolean;
  data?: {
    id: string;
    domain_name: string;
    target_url: string;
    status: string;
    server_ip?: string;
    expires_at?: string;
  };
  cost?: number;
  error?: string;
  code?: string;
}

export interface CdnProxyItem {
  id: string;
  domain_name: string;
  target_url: string | null;
  status: string;
  lifecycle_status: string;
  server_ip: string | null;
  expires_at: string | null;
  created_at: string;
  auto_renew?: boolean;
}

export interface CdnListProxiesResponse {
  success: boolean;
  data?: CdnProxyItem[];
  error?: string;
}

export interface CdnActionResponse {
  success: boolean;
  error?: string;
  code?: string;
}

/**
 * Fetch CDN API with Bot API key.
 */
function pickCdnErrorMessage(data: unknown, fallbackStatus: number, rawBody: string): string {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const err = o.error;
    if (typeof err === "string" && err.trim()) return err.trim();
    const msg = o.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    if (Array.isArray(msg) && msg.length > 0) {
      const parts = msg.filter((x): x is string => typeof x === "string");
      if (parts.length) return parts.join("; ").slice(0, 500);
    }
    const detail = o.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
  }
  const trimmed = rawBody.trim();
  if (trimmed && trimmed.length < 800 && !trimmed.startsWith("<!")) {
    return trimmed.slice(0, 500);
  }
  return `CDN API ${fallbackStatus}`;
}

async function cdnFetch<T>(
  path: string,
  options: { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}
): Promise<T> {
  const base = getBaseUrl();
  const key = getApiKey();
  if (!base || !key) {
    throw new Error("CDN_BASE_URL and CDN_BOT_API_KEY must be set");
  }

  const { method = "GET", body, headers: customHeaders } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Bot-Api-Key": key,
    ...((customHeaders as Record<string, string>) ?? {}),
  };

  const url = `${base}${path}`;
  const timeoutMs = Number.parseInt(process.env.CDN_HTTP_TIMEOUT_MS ?? "7000", 10);
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 2000 ? timeoutMs : 7000;
  const maxAttempts = 1;
  let res: Response | null = null;
  let lastTransportError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    try {
      res = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body != null ? { body: JSON.stringify(body) } : {}),
      });
      break;
    } catch (error) {
      lastTransportError = error;
      const isAbort = (error as { name?: string })?.name === "AbortError";
      if (isAbort && attempt < maxAttempts) {
        continue;
      }
      if (isAbort) {
        throw new Error("CDN API timeout. Try again in a moment.");
      }
      if (attempt >= maxAttempts) {
        throw new Error(
          `CDN request failed: ${(error as { message?: string })?.message || "Network error"}`
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!res) {
    if (lastTransportError instanceof Error) throw lastTransportError;
    throw new Error("CDN request failed");
  }

  const raw = await res.text();
  let data: unknown = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    const message = pickCdnErrorMessage(data, res.status, raw);
    const { Logger } = await import("../../app/logger.js");
    const preview = raw.replace(/\s+/g, " ").slice(0, 400);
    Logger.error(`[CdnClient] HTTP ${res.status} ${path}: ${message}${preview ? ` | ${preview}` : ""}`);
    const err = new Error(message);
    (err as any).status = res.status;
    (err as any).code =
      data && typeof data === "object" && typeof (data as { code?: string }).code === "string"
        ? (data as { code: string }).code
        : undefined;
    throw err;
  }
  return data as T;
}

/**
 * Get proxy price (USD) from CDN service.
 */
export async function cdnGetPrice(): Promise<number> {
  const out = await cdnFetch<CdnPriceResponse>("/api/bot/price");
  if (!out.success || out.data?.price == null) {
    throw new Error(out.error ?? "Failed to get CDN price");
  }
  return Number(out.data.price);
}

/**
 * Create a reverse proxy for the given Telegram user (payment already taken by bot).
 */
export async function cdnCreateProxy(params: {
  telegramId: number;
  username?: string;
  domainName: string;
  targetUrl: string;
  description?: string;
  forceHttps?: boolean;
  hostHeader?: "incoming" | "target";
  cachingEnabled?: boolean;
}): Promise<CdnCreateProxyResponse> {
  const snake = process.env.CDN_BOT_CREATE_PROXY_SNAKE === "1";
  const forceHttps = params.forceHttps ?? true;
  const hostHeader = params.hostHeader ?? "incoming";
  const cachingEnabled = params.cachingEnabled ?? false;
  const detectedPlan =
    String(params.description ?? "")
      .replace(/^plan=/, "")
      .trim()
      .toLowerCase() || "standard";

  const rawBody = snake
    ? {
        telegram_id: params.telegramId,
        username: params.username,
        domain_name: params.domainName,
        target_url: params.targetUrl,
        description: params.description,
        force_https: forceHttps,
        host_header: hostHeader,
        caching_enabled: cachingEnabled,
      }
    : {
        telegramId: params.telegramId,
        username: params.username,
        domainName: params.domainName,
        targetUrl: params.targetUrl,
        description: params.description,
        forceHttps,
        hostHeader,
        cachingEnabled,
      };

  const body = Object.fromEntries(
    Object.entries(rawBody).filter(([, v]) => v !== undefined)
  ) as Record<string, unknown>;
  const bodyWithPlan = {
    ...body,
    plan: detectedPlan,
    planId: detectedPlan,
    tariff: detectedPlan,
  };
  const bodyWithPlanSnake = {
    ...body,
    plan: detectedPlan,
    plan_id: detectedPlan,
    tariff: detectedPlan,
  };

  const attempts: Array<{ path: string; body: Record<string, unknown> }> = [
    { path: "/api/bot/create-proxy", body: bodyWithPlanSnake },
    { path: "/api/bot/create-proxy", body: bodyWithPlan },
    { path: "/api/bot/proxy/create", body: bodyWithPlanSnake },
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const out = await cdnFetch<CdnCreateProxyResponse>(attempt.path, {
        method: "POST",
        body: attempt.body,
      });
      if (out.success) {
        return out;
      }
      const err = new Error(out.error ?? "Create failed");
      (err as any).code = out.code;
      lastError = err;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Failed to create CDN proxy");
}

/**
 * List reverse proxies for the given Telegram user.
 */
export async function cdnListProxies(telegramId: number): Promise<CdnProxyItem[]> {
  const variants = [
    `/api/bot/proxies?telegramId=${encodeURIComponent(telegramId)}`,
    `/api/bot/proxies?telegram_id=${encodeURIComponent(telegramId)}`,
    `/api/bot/list-proxies?telegramId=${encodeURIComponent(telegramId)}`,
    `/api/bot/list-proxies?telegram_id=${encodeURIComponent(telegramId)}`,
  ];

  let lastError: unknown;
  for (const path of variants) {
    try {
      const out = await cdnFetch<CdnListProxiesResponse>(path);
      if (out.success) {
        return out.data ?? [];
      }
      lastError = new Error(out.error ?? "Failed to list CDN proxies");
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Failed to list CDN proxies");
}

async function tryAction(
  attempts: Array<{
    path: string;
    method?: string;
    body?: Record<string, unknown>;
  }>
): Promise<boolean> {
  for (const attempt of attempts) {
    try {
      const out = await cdnFetch<CdnActionResponse>(attempt.path, {
        method: attempt.method ?? "POST",
        body: attempt.body,
      });
      if (out.success) return true;
    } catch {
      // Try next variant.
    }
  }
  return false;
}

export async function cdnRenewProxy(proxyId: string, telegramId: number): Promise<boolean> {
  return tryAction([
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}/renew`,
      method: "POST",
      body: { telegramId },
    },
    {
      path: `/api/bot/renew-proxy`,
      method: "POST",
      body: { proxyId, telegramId },
    },
  ]);
}

export async function cdnToggleAutoRenew(
  proxyId: string,
  telegramId: number,
  enabled: boolean
): Promise<boolean> {
  return tryAction([
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}/auto-renew`,
      method: "POST",
      body: { enabled, telegramId },
    },
    {
      path: `/api/bot/toggle-auto-renew`,
      method: "POST",
      body: { proxyId, enabled, telegramId },
    },
  ]);
}

export async function cdnRetrySsl(proxyId: string, telegramId: number): Promise<boolean> {
  return tryAction([
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}/retry-ssl`,
      method: "POST",
      body: { telegramId },
    },
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}/retry-issuance`,
      method: "POST",
      body: { telegramId },
    },
  ]);
}

export async function cdnDeleteProxy(
  proxyId: string,
  telegramId: number,
  options?: { domainName?: string | null; targetUrl?: string | null }
): Promise<boolean> {
  const domainName = options?.domainName?.trim() || undefined;
  const targetUrl = options?.targetUrl?.trim() || undefined;
  const attempts: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}?telegramId=${encodeURIComponent(
        telegramId
      )}`,
      method: "DELETE",
    },
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}`,
      method: "DELETE",
      body: { telegramId },
    },
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}`,
      method: "POST",
      body: { action: "delete", telegramId },
    },
    {
      path: `/api/bot/proxy/${encodeURIComponent(proxyId)}/delete`,
      method: "POST",
      body: { telegramId },
    },
    {
      path: `/api/bot/proxies/${encodeURIComponent(proxyId)}`,
      method: "DELETE",
      body: { telegramId },
    },
    {
      path: `/api/bot/proxies/${encodeURIComponent(proxyId)}/delete`,
      method: "POST",
      body: { telegramId },
    },
    {
      path: `/api/bot/delete-proxy`,
      method: "POST",
      body: { proxyId, telegramId },
    },
    {
      path: `/api/bot/delete-proxy`,
      method: "POST",
      body: { proxy_id: proxyId, telegram_id: telegramId },
    },
    {
      path: `/api/bot/delete-proxy?proxyId=${encodeURIComponent(proxyId)}&telegramId=${encodeURIComponent(
        telegramId
      )}`,
      method: "DELETE",
    },
  ];

  if (domainName) {
    attempts.push(
      {
        path: `/api/bot/delete-proxy`,
        method: "POST",
        body: { domainName, telegramId },
      },
      {
        path: `/api/bot/delete-proxy`,
        method: "POST",
        body: { domain_name: domainName, telegram_id: telegramId },
      },
      {
        path: `/api/bot/proxy/by-domain/${encodeURIComponent(domainName)}?telegramId=${encodeURIComponent(
          telegramId
        )}`,
        method: "DELETE",
      },
      {
        path: `/api/bot/proxy?domainName=${encodeURIComponent(domainName)}&telegramId=${encodeURIComponent(
          telegramId
        )}`,
        method: "DELETE",
      }
    );
  }

  if (targetUrl) {
    attempts.push(
      {
        path: `/api/bot/delete-proxy`,
        method: "POST",
        body: { proxyId, targetUrl, telegramId },
      },
      {
        path: `/api/bot/delete-proxy`,
        method: "POST",
        body: { proxy_id: proxyId, target_url: targetUrl, telegram_id: telegramId },
      }
    );
  }

  return tryAction(attempts);
}
