/**
 * WHOIS-based domain availability check (fallback when Amper check returns VALIDATION_ERROR).
 *
 * @module infrastructure/domains/whoisAvailability
 */

import { lookup as whoisLookup } from "whois";
import { Logger } from "../../app/logger.js";
import type { DomainAvailabilityResult } from "./DomainProvider.js";

function lookup(domain: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    whoisLookup(domain, { timeout: timeoutMs }, ((err: Error | null, data: string | import("whois").WhoisResult[]) => {
      if (err) reject(err);
      else resolve(typeof data === "string" ? data ?? "" : "");
    }) as import("whois").WhoisCallback);
  });
}

/** TLDs we try to check via WHOIS. Some TLDs have no public WHOIS or different format. */
const COMMON_TLDS = new Set([
  "com", "net", "org", "info", "biz", "io", "co", "ru", "de", "uk", "eu",
  "xyz", "online", "site", "store", "tech", "app", "dev", "lat", "me",
]);

/**
 * Check domain availability via WHOIS.
 * Returns available: true if WHOIS suggests domain is free (No match / Not found / AVAILABLE).
 * Returns available: false if WHOIS shows domain is registered.
 * On parse/network error returns available: false with reason (so we don't block registration).
 */
export async function checkAvailabilityWhois(domain: string): Promise<DomainAvailabilityResult> {
  const normalized = domain.trim().toLowerCase();
  if (!normalized.includes(".")) {
    return { available: false, domain, reason: "Invalid domain format" };
  }
  const tld = normalized.split(".").pop() || "";
  if (!COMMON_TLDS.has(tld)) {
    Logger.debug(`[Whois] TLD .${tld} not in common list, trying anyway`);
  }

  try {
    const data = await Promise.race([
      lookup(normalized, 10000),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("WHOIS timeout")), 11000)
      ),
    ]);
    const text = typeof data === "string" ? data : String(data);
    const lower = text.toLowerCase();

    // "No match" / "Not found" / "AVAILABLE" → domain free (common in .com, .net, .org, etc.)
    const noMatch =
      lower.includes("no match for") ||
      lower.includes("not found") ||
      lower.includes("no entries found") ||
      lower.includes("status: available") ||
      lower.includes("domain not found") ||
      lower.includes("is free");
    // Registered: has "Name Server:" or "nserver" (delegations) or "Domain Name:" with value
    const hasNameServer = /\bname\s*server\s*:/i.test(text) || /\bnserver\s*:/i.test(text);
    const hasDomainRecord = hasNameServer || (/\bdomain\s*name\s*:\s*\S/i.test(text) && !noMatch);

    if (noMatch && !hasNameServer) {
      Logger.info(`[Whois] ${domain} — appears available (no match / available)`);
      return { available: true, domain };
    }
    if (hasDomainRecord) {
      Logger.info(`[Whois] ${domain} — appears registered`);
      return { available: false, domain, reason: "Domain is already registered" };
    }

    // Unclear — treat as available so user can try registration (Amper will confirm)
    Logger.warn(`[Whois] ${domain} — could not determine, treating as available`);
    return { available: true, domain };
  } catch (err: any) {
    const msg = err?.message || String(err);
    Logger.warn(`[Whois] ${domain} lookup failed:`, msg);
    // Сетевые ошибки (VPS не может достучаться до WHOIS:43) — не блокируем регистрацию
    const isNetworkError =
      /EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|timeout|ECONNRESET|network/i.test(msg);
    if (isNetworkError) {
      Logger.info(`[Whois] ${domain} — network error, allowing registration attempt (Amper will check)`);
      return { available: true, domain };
    }
    return {
      available: false,
      domain,
      reason: msg || "WHOIS check failed",
    };
  }
}
