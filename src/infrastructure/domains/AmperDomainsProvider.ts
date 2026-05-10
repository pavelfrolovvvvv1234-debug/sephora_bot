/**
 * AmperDomainsProvider implementation for @amper_domains_bot API.
 *
 * @module infrastructure/domains/AmperDomainsProvider
 */

import type { DomainProvider } from "./DomainProvider.js";
import type {
  DomainAvailabilityResult,
  DomainPrice,
  DomainRegistrationRequest,
  DomainRegistrationResult,
  DomainInfo,
  DomainRenewalRequest,
  DomainRenewalResult,
  NameserverUpdateRequest,
  NameserverUpdateResult,
  OperationStatusResult,
} from "./DomainProvider.js";
import axios, { AxiosInstance } from "axios";
import { Logger } from "../../app/logger.js";
import { checkAvailabilityWhois } from "./whoisAvailability.js";

/**
 * AmperDomainsProvider configuration.
 */
export interface AmperConfig {
  apiBaseUrl: string;
  apiToken: string;
  timeoutMs: number;
  defaultNs1?: string;
  defaultNs2?: string;
}

/**
 * AmperDomainsProvider implementation.
 * 
 * NOTE: This is a stub implementation. Actual API endpoints and formats
 * need to be provided by the partner (@amper_domains_bot).
 * 
 * See docs/amper_domains_integration.md for required API specification.
 */
export class AmperDomainsProvider implements DomainProvider {
  private client: AxiosInstance;
  private apiPrefix = "/api/v1";
  private docsSuffixes = ["/docs", "/docs/"];

  constructor(private config: AmperConfig) {
    if (!config.apiToken) {
      Logger.warn("AmperDomainsProvider initialized without API token");
    }
    const baseUrl = this.normalizeBaseUrl(config.apiBaseUrl);
    const token = config.apiToken?.startsWith("ApiKey ")
      ? config.apiToken
      : `ApiKey ${config.apiToken}`;
    
    Logger.info(`AmperDomainsProvider initialized with baseUrl: ${baseUrl}`);
    
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: config.timeoutMs,
      headers: {
        "Authorization": token,
        "Content-Type": "application/json",
      },
    });
  }

  private normalizeBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) {
      return trimmed;
    }
    const withoutDocs = this.stripDocsSuffix(trimmed);
    if (withoutDocs.endsWith(this.apiPrefix)) {
      return withoutDocs.slice(0, -this.apiPrefix.length);
    }
    return withoutDocs;
  }

  private stripDocsSuffix(value: string): string {
    for (const suffix of this.docsSuffixes) {
      if (value.endsWith(suffix)) {
        return value.slice(0, -suffix.length);
      }
    }
    return value;
  }

  /**
   * Read field from API response supporting both camelCase and snake_case.
   */
  private getResp<T>(data: any, ...keys: string[]): T | undefined {
    if (!data || typeof data !== "object") return undefined;
    for (const key of keys) {
      if (data[key] !== undefined && data[key] !== null) return data[key] as T;
    }
    return undefined;
  }

  /**
   * Check if domain is available for registration.
   * Tries GET /api/v1/domains/check first; on 400 VALIDATION_ERROR retries with name+tld.
   * If Amper still returns VALIDATION_ERROR, falls back to WHOIS availability check.
   */
  async checkAvailability(domain: string): Promise<DomainAvailabilityResult> {
    const result = await this.checkAvailabilityOnce(domain, { domain });
    if (result.formatError) {
      const lastDot = domain.lastIndexOf(".");
      if (lastDot > 0) {
        const name = domain.slice(0, lastDot);
        const tld = domain.slice(lastDot + 1);
        if (name && tld) {
          Logger.info(`[Amper] check retry with name=${name}, tld=${tld}`);
          const retryResult = await this.checkAvailabilityOnce(domain, {
            name,
            tld,
          });
          if (!retryResult.formatError) return retryResult;
        }
      }
      // Amper check не поддерживает формат — проверяем через WHOIS
      Logger.info(`[Amper] check returned VALIDATION_ERROR for ${domain}, using WHOIS fallback`);
      const whoisResult = await checkAvailabilityWhois(domain);
      return whoisResult;
    }
    return result;
  }

  /**
   * Single check request. Params shape: { domain } or { name, tld }.
   */
  private async checkAvailabilityOnce(
    domain: string,
    params: { domain?: string; name?: string; tld?: string }
  ): Promise<DomainAvailabilityResult> {
    try {
      Logger.info(`[Amper] Checking availability for ${domain} with params:`, params);
      const response = await this.client.get(`${this.apiPrefix}/domains/check`, {
        params,
      });
      const data = response.data ?? {};
      Logger.info(`[Amper] Check response for ${domain}:`, {
        status: response.status,
        data: JSON.stringify(data),
      });
      const available = this.parseAvailableStatus(data);
      const reason =
        data.reason ||
        data.message ||
        data?.result?.reason ||
        data?.data?.reason ||
        data?.error ||
        undefined;
      Logger.info(`[Amper] Parsed availability for ${domain}:`, {
        available,
        reason,
      });
      return { available, domain, reason };
    } catch (error: any) {
      const responseData = error?.response?.data;
      const statusCode = error?.response?.status;
      const apiError = responseData?.error;
      const errorMessage =
        (typeof apiError === "object" ? apiError?.message : null) ||
        responseData?.message ||
        (typeof responseData?.error === "string" ? responseData.error : null) ||
        error.message ||
        "API error checking domain availability";

      Logger.error(
        `Failed to check domain availability for ${domain}:`,
        JSON.stringify({
          status: statusCode,
          data: responseData,
          message: errorMessage,
        })
      );

      // Временные ошибки сервера (502, 503, 504) - можно повторить позже
      if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
        Logger.warn(
          `[Amper] Temporary server error ${statusCode} for ${domain} - service unavailable`
        );
        return {
          available: false,
          domain,
          reason: `Service temporarily unavailable (${statusCode}). Please try again later.`,
          formatError: false,
        };
      }

      if (statusCode === 404) {
        Logger.info(`Domain ${domain} returned 404 - treating as available`);
        return {
          available: true,
          domain,
          reason: "Domain not found in registry (available)",
        };
      }

      if (statusCode === 400 && apiError?.code === "VALIDATION_ERROR") {
        return {
          available: false,
          domain,
          reason: errorMessage,
          formatError: true,
        };
      }

      if (statusCode === 401 || apiError?.code === "INVALID_API_KEY") {
        throw new Error("Invalid or expired Amper API key. Check AMPER_API_TOKEN in .env");
      }

      throw new Error(errorMessage);
    }
  }

  /**
   * Parse available status from various API response formats.
   * Handles: boolean, string, nested objects, different field names.
   */
  private parseAvailableStatus(data: any): boolean {
    if (!data || typeof data !== "object") {
      return false;
    }

    // Direct boolean check
    if (data.available === true || data.available === "true" || data.available === 1) {
      return true;
    }
    if (data.available === false || data.available === "false" || data.available === 0) {
      return false;
    }

    // Check nested result object
    if (data.result) {
      if (data.result.available === true || data.result.available === "true" || data.result.available === 1) {
        return true;
      }
      if (data.result.available === false || data.result.available === "false" || data.result.available === 0) {
        return false;
      }
    }

    // Check nested data object
    if (data.data) {
      if (data.data.available === true || data.data.available === "true" || data.data.available === 1) {
        return true;
      }
      if (data.data.available === false || data.data.available === "false" || data.data.available === 0) {
        return false;
      }
    }

    // Check status field (common alternative format)
    if (typeof data.status === "string") {
      const statusLower = data.status.toLowerCase();
      if (["available", "free", "ok", "success", "not_registered", "not registered"].includes(statusLower)) {
        return true;
      }
      if (["unavailable", "taken", "registered", "busy", "error", "fail"].includes(statusLower)) {
        return false;
      }
    }

    // Check is_available field (alternative naming)
    if (data.is_available === true || data.is_available === "true" || data.is_available === 1) {
      return true;
    }
    if (data.is_available === false || data.is_available === "false" || data.is_available === 0) {
      return false;
    }

    // Check isAvailable field (camelCase alternative)
    if (data.isAvailable === true || data.isAvailable === "true" || data.isAvailable === 1) {
      return true;
    }
    if (data.isAvailable === false || data.isAvailable === "false" || data.isAvailable === 0) {
      return false;
    }

    // Check free field (some APIs use this)
    if (data.free === true || data.free === "true" || data.free === 1) {
      return true;
    }
    if (data.free === false || data.free === "false" || data.free === 0) {
      return false;
    }

    // If we can't determine, log warning and default to false (safer)
    Logger.warn(
      "Amper checkAvailability: could not parse available status from response",
      JSON.stringify(data)
    );
    
    return false;
  }

  /**
   * Get price for domain registration.
   * Tries tld+period first (per spec), then domain+period if API expects full domain.
   */
  async getPrice(tld: string, period: number): Promise<DomainPrice> {
    const tldNorm = tld.replace(/^\.+/, "");
    const domainForPrice = `example.${tldNorm}`;
    const tryParams = [
      { tld: tldNorm, period },
      { domain: domainForPrice, period },
    ];
    for (const params of tryParams) {
      try {
        const response = await this.client.get(`${this.apiPrefix}/domains/price`, { params });
        const d = response.data ?? {};
        const price = Number(this.getResp<number>(d, "price") ?? 0);
        const currency = (this.getResp<string>(d, "currency") ?? "USD").toString();
        return { tld: tldNorm, period, price, currency };
      } catch (error: any) {
        const status = error?.response?.status;
        const code = error?.response?.data?.error?.code;
        if (status === 400 && code === "VALIDATION_ERROR") {
          continue;
        }
        const responseData = error?.response?.data;
        Logger.error(
          `Failed to get price for ${tldNorm} (${period}y):`,
          responseData ? JSON.stringify(responseData) : error?.message
        );
        throw new Error(`Failed to get domain price: ${error.message}`);
      }
    }
    // Amper возвращает 400 VALIDATION_ERROR на оба варианта параметров — отдаём заглушку, чтобы бот не падал
    Logger.warn(
      `Amper getPrice: 400 for ${tldNorm}. Уточните формат в https://amper.lat/api/v1/docs или у поддержки Amper.`
    );
    return { tld: tldNorm, period, price: 0, currency: "USD" };
  }

  /**
   * Register domain.
   */
  async registerDomain(request: DomainRegistrationRequest): Promise<DomainRegistrationResult> {
    try {
      // Amper API ожидает nameservers как массив, а не объект
      const ns1 = request.ns1 || this.config.defaultNs1;
      const ns2 = request.ns2 || this.config.defaultNs2;
      const nameserversArray: string[] = [];
      if (ns1) nameserversArray.push(ns1);
      if (ns2) nameserversArray.push(ns2);
      
      const body: Record<string, unknown> = {
        domain: request.domain,
        period: request.period,
        nameservers: nameserversArray,
      };
      if (request.contact && Object.keys(request.contact).length > 0) {
        body.contact = request.contact;
      }
      Logger.info(`[Amper] Registering domain ${request.domain}`, { body });
      const response = await this.client.post(`${this.apiPrefix}/domains/register`, body);
      const d = response.data ?? {};
      Logger.info(`[Amper] Register response for ${request.domain}:`, {
        status: response.status,
        data: JSON.stringify(d),
      });
      const success = d.success === true || d.success === "true";
      const domainId = this.getResp<string>(d, "domainId", "domain_id");
      const operationId = this.getResp<string>(d, "operationId", "operation_id");
      const error = this.getResp<string>(d, "error");
      Logger.info(`[Amper] Parsed result for ${request.domain}:`, {
        success,
        domainId,
        operationId,
        error,
      });
      return { success, domainId, operationId, error };
    } catch (error: any) {
      const statusCode = error.response?.status;
      const statusText = error.response?.statusText;
      
      Logger.error(`[Amper] Failed to register domain ${request.domain}:`, {
        status: statusCode,
        statusText,
        data: JSON.stringify(error.response?.data),
        message: error.message,
        fullError: error,
      });
      
      // Временные ошибки сервера (502, 503, 504)
      if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
        return {
          success: false,
          error: `Service temporarily unavailable (${statusCode}). Please try again in a few minutes.`,
        };
      }
      
      const errData = error.response?.data;
      const apiError = errData?.error;
      
      // 402 / INSUFFICIENT_BALANCE — на счёте Amper нет средств
      if (statusCode === 402 || apiError?.code === "INSUFFICIENT_BALANCE") {
        return { success: false, error: "Insufficient balance on registrar (Amper). Top up Amper account." };
      }
      const errMsg =
        (typeof apiError === "object" && apiError?.message ? apiError.message : null) ||
        (typeof errData?.message === "string" ? errData.message : null) ||
        (typeof errData?.error === "string" ? errData.error : null) ||
        (typeof apiError === "string" ? apiError : null) ||
        error.message ||
        "Unknown error";
      
      const domainIdFromError = this.getResp<string>(errData, "domainId", "domain_id");
      const errMsgLower = errMsg.toLowerCase();
      if (
        errMsgLower.includes("not available") ||
        errMsgLower.includes("already registered") ||
        errMsgLower.includes("already taken") ||
        errMsgLower.includes("unavailable") ||
        errMsgLower.includes("недоступен") ||
        errMsgLower.includes("уже занят")
      ) {
        return { success: false, error: "Domain is not available", domainId: domainIdFromError };
      }
      if (errMsgLower.includes("already owned by you") || errMsgLower.includes("owned by you")) {
        return { success: false, error: errMsg, domainId: domainIdFromError };
      }
      return { success: false, error: errMsg, domainId: domainIdFromError };
    }
  }

  /**
   * List domains. If userId is non-empty, passes it as query param (Amper may filter by it).
   * If userId is empty, requests without params — Amper often returns all domains for the API key.
   */
  async listDomains(userId: string): Promise<DomainInfo[]> {
    try {
      const config: { params?: Record<string, string> } = {};
      if (userId !== "") {
        config.params = { userId };
      }
      const response = await this.client.get(`${this.apiPrefix}/domains`, config);
      const raw = response.data;
      const list =
        Array.isArray(raw?.domains) ? raw.domains
        : Array.isArray(raw?.list) ? raw.list
        : Array.isArray(raw) ? raw
        : [];
      if (list.length === 0 && raw && typeof raw === "object") {
        Logger.warn(`[Amper] listDomains empty`, {
          userId: userId || "(all)",
          responseKeys: Object.keys(raw),
          status: response.status,
        });
      }
      return list.map((d: any) => this.mapDomainInfo(d));
    } catch (error: any) {
      Logger.error(`Failed to list domains for user ${userId}:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      return [];
    }
  }

  /**
   * Try to get a single domain by name (e.g. GET /domains?domain=example.com).
   * Returns one-item array if found, else [].
   */
  async listDomainsByDomain(domainName: string): Promise<DomainInfo[]> {
    try {
      const response = await this.client.get(`${this.apiPrefix}/domains`, {
        params: { domain: domainName },
      });
      const raw = response.data;
      const list =
        Array.isArray(raw?.domains) ? raw.domains
        : Array.isArray(raw?.list) ? raw.list
        : raw && typeof raw === "object" && !Array.isArray(raw) && (raw.domain || raw.domainId || raw.domain_id)
          ? [raw]
        : Array.isArray(raw) ? raw
        : [];
      return list.map((d: any) => this.mapDomainInfo(d));
    } catch (error: any) {
      Logger.error(`[Amper] listDomainsByDomain(${domainName}) failed:`, {
        message: error.message,
        status: error.response?.status,
      });
      return [];
    }
  }

  private mapDomainInfo(d: any): DomainInfo {
    const expireAt = this.getResp<string>(d, "expireAt", "expire_at");
    const registeredAt = this.getResp<string>(d, "registeredAt", "registered_at");
    return {
      domain: this.getResp<string>(d, "domain", "name") ?? "",
      domainId: this.getResp<string>(d, "domainId", "domain_id", "id") ?? "",
      status: this.getResp<string>(d, "status") ?? "unknown",
      expireAt: expireAt ? new Date(expireAt) : undefined,
      ns1: this.getResp<string>(d, "ns1"),
      ns2: this.getResp<string>(d, "ns2"),
      registeredAt: registeredAt ? new Date(registeredAt) : undefined,
    };
  }

  /**
   * Get domain information.
   */
  async getDomain(domainId: string): Promise<DomainInfo | null> {
    try {
      const response = await this.client.get(`${this.apiPrefix}/domains/${domainId}`);
      return this.mapDomainInfo(response.data ?? {});
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      Logger.error(`Failed to get domain ${domainId}:`, error);
      return null;
    }
  }

  /**
   * Renew domain.
   */
  async renewDomain(request: DomainRenewalRequest): Promise<DomainRenewalResult> {
    try {
      const response = await this.client.post(
        `${this.apiPrefix}/domains/${encodeURIComponent(request.domainId)}/renew`,
        { period: request.period }
      );
      const d = response.data ?? {};
      const success = d.success === true || d.success === "true";
      const operationId = this.getResp<string>(d, "operationId", "operation_id");
      const error = this.getResp<string>(d, "error");
      return { success, operationId, error };
    } catch (error: any) {
      Logger.error(`Failed to renew domain ${request.domainId}:`, error);
      const errMsg =
        error.response?.data?.message ?? error.response?.data?.error ?? error.message ?? "Unknown error";
      return { success: false, error: String(errMsg) };
    }
  }

  /**
   * Update nameservers.
   * Сначала объект { ns1, ns2 }; при 400 "expected array" — массив nameservers (как в register).
   */
  async updateNameservers(request: NameserverUpdateRequest): Promise<NameserverUpdateResult> {
    const url = `${this.apiPrefix}/domains/${encodeURIComponent(request.domainId)}/nameservers`;
    const tryBody = (body: Record<string, unknown>) =>
      this.client.put(url, body).then((response) => {
        const d = response.data ?? {};
        return {
          success: d.success === true || d.success === "true",
          operationId: this.getResp<string>(d, "operationId", "operation_id"),
          error: this.getResp<string>(d, "error"),
        };
      });
    try {
      return await tryBody({ ns1: request.ns1, ns2: request.ns2 });
    } catch (err: any) {
      const msg = (err.response?.data?.error?.message || err.message || "").toLowerCase();
      if (err.response?.status === 400 && msg.includes("expected array")) {
        Logger.info(`[Amper] updateNameservers: retry with nameservers array`);
        try {
          return await tryBody({
            nameservers: [request.ns1, request.ns2].filter(Boolean),
          });
        } catch (e: any) {
          const errMsg = e.response?.data?.error?.message ?? e.message ?? "Unknown error";
          return { success: false, error: String(errMsg) };
        }
      }
      Logger.error(`Failed to update nameservers for domain ${request.domainId}:`, err);
      const errMsg =
        err.response?.data?.error?.message ??
        err.response?.data?.message ??
        err.message ??
        "Unknown error";
      return { success: false, error: String(errMsg) };
    }
  }

  /**
   * Get operation status.
   */
  async getOperationStatus(operationId: string): Promise<OperationStatusResult> {
    try {
      const response = await this.client.get(
        `${this.apiPrefix}/operations/${encodeURIComponent(operationId)}`
      );
      const d = response.data ?? {};
      const statusRaw = this.getResp<string>(d, "status");
      const status =
        statusRaw === "pending" || statusRaw === "in_progress" || statusRaw === "completed" || statusRaw === "failed"
          ? statusRaw
          : "pending";
      const result = this.getResp(d, "result");
      const error = this.getResp<string>(d, "error");
      return { status, result, error };
    } catch (error: any) {
      Logger.error(`Failed to get operation status ${operationId}:`, error);
      const errMsg =
        error.response?.data?.message ?? error.response?.data?.error ?? error.message ?? "Unknown error";
      return { status: "failed", error: String(errMsg) };
    }
  }
}
