/**
 * DomainProvider interface for domain registration providers.
 *
 * @module infrastructure/domains/DomainProvider
 */

/**
 * Domain availability check result.
 */
export interface DomainAvailabilityResult {
  available: boolean;
  domain: string;
  reason?: string; // If not available, reason why
  /** True only when API returned 400 VALIDATION_ERROR (format), not for "domain taken". */
  formatError?: boolean;
}

/**
 * Domain price information.
 */
export interface DomainPrice {
  tld: string;
  period: number; // Years
  price: number;
  currency?: string; // Default: USD
}

/**
 * Domain registration request.
 */
export interface DomainRegistrationRequest {
  domain: string;
  period: number; // Years
  ns1?: string;
  ns2?: string;
  contact?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    country?: string;
    zipCode?: string;
  };
}

/**
 * Domain registration result.
 */
export interface DomainRegistrationResult {
  success: boolean;
  domainId?: string; // Provider domain ID
  operationId?: string; // Provider operation ID (for async operations)
  error?: string;
}

/**
 * Domain information.
 */
export interface DomainInfo {
  domain: string;
  domainId: string;
  status: string;
  expireAt?: Date;
  ns1?: string;
  ns2?: string;
  registeredAt?: Date;
}

/**
 * Nameserver update request.
 */
export interface NameserverUpdateRequest {
  domainId: string;
  ns1: string;
  ns2: string;
}

/**
 * Nameserver update result.
 */
export interface NameserverUpdateResult {
  success: boolean;
  operationId?: string;
  error?: string;
}

/**
 * Domain renewal request.
 */
export interface DomainRenewalRequest {
  domainId: string;
  period: number; // Years
}

/**
 * Domain renewal result.
 */
export interface DomainRenewalResult {
  success: boolean;
  operationId?: string;
  error?: string;
}

/**
 * Operation status result.
 */
export interface OperationStatusResult {
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: any;
  error?: string;
}

/**
 * DomainProvider interface for domain registration providers.
 */
export interface DomainProvider {
  /**
   * Check if domain is available for registration.
   *
   * @param domain - Full domain name (e.g., "example.com")
   * @returns Availability result
   */
  checkAvailability(domain: string): Promise<DomainAvailabilityResult>;

  /**
   * Get price for domain registration.
   *
   * @param tld - Top-level domain (e.g., "com")
   * @param period - Registration period in years
   * @returns Price information
   */
  getPrice(tld: string, period: number): Promise<DomainPrice>;

  /**
   * Register domain.
   *
   * @param request - Registration request
   * @returns Registration result
   */
  registerDomain(request: DomainRegistrationRequest): Promise<DomainRegistrationResult>;

  /**
   * List domains for a user.
   *
   * @param userId - User identifier (provider-specific)
   * @returns List of domains
   */
  listDomains(userId: string): Promise<DomainInfo[]>;

  /**
   * Get domain information.
   *
   * @param domainId - Provider domain ID
   * @returns Domain information
   */
  getDomain(domainId: string): Promise<DomainInfo | null>;

  /**
   * Renew domain.
   *
   * @param request - Renewal request
   * @returns Renewal result
   */
  renewDomain(request: DomainRenewalRequest): Promise<DomainRenewalResult>;

  /**
   * Update nameservers.
   *
   * @param request - Nameserver update request
   * @returns Update result
   */
  updateNameservers(request: NameserverUpdateRequest): Promise<NameserverUpdateResult>;

  /**
   * Get operation status.
   *
   * @param operationId - Provider operation ID
   * @returns Operation status
   */
  getOperationStatus(operationId: string): Promise<OperationStatusResult>;
}
