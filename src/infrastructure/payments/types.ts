/**
 * Payment provider types and interfaces.
 *
 * @module infrastructure/payments/types
 */

/**
 * Payment provider identifier.
 */
export type PaymentProviderName = "crystalpay" | "cryptobot" | "heleket";

/**
 * Invoice status.
 */
export enum InvoiceStatus {
  PENDING = "pending",
  PAID = "paid",
  EXPIRED = "expired",
  FAILED = "failed",
}

/**
 * Invoice information.
 */
export interface Invoice {
  id: string;
  url: string;
  amount: number;
  provider: PaymentProviderName;
  status: InvoiceStatus;
  expiresAt?: Date;
}

/**
 * Payment provider interface for unified payment processing.
 */
export interface IPaymentProvider {
  /**
   * Provider identifier.
   */
  readonly name: PaymentProviderName;

  /**
   * Create a new payment invoice.
   *
   * @param amount - Payment amount in USD
   * @param orderId - Unique order identifier
   * @param metadata - Optional metadata
   * @returns Created invoice
   * @throws {PaymentError} If invoice creation fails
   */
  createInvoice(
    amount: number,
    orderId: string,
    metadata?: Record<string, unknown>
  ): Promise<Invoice>;

  /**
   * Check invoice status.
   *
   * @param invoiceId - Invoice/order ID
   * @returns Current invoice status
   * @throws {PaymentError} If status check fails
   */
  checkStatus(invoiceId: string): Promise<InvoiceStatus>;

  /**
   * Get invoice details.
   *
   * @param invoiceId - Invoice/order ID
   * @returns Invoice details
   * @throws {PaymentError} If invoice retrieval fails
   */
  getInvoice(invoiceId: string): Promise<Invoice>;
}
