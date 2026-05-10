/**
 * CrystalPay payment provider adapter.
 *
 * @module infrastructure/payments/crystalpay
 */

import type { IPaymentProvider, Invoice } from "./types";
import { PaymentProviderName, InvoiceStatus } from "./types"; // InvoiceStatus as value for enum use
import { PaymentError } from "../../shared/errors/index";
import { config } from "../../app/config";
import { Logger } from "../../app/logger";
// TODO: Move CrystalPayClient to infrastructure/payments/crystal-pay-client.ts
// Temporarily importing from old location
import { CrystalPayClient } from "../../api/crystal-pay";

/**
 * CrystalPay payment provider implementation.
 */
export class CrystalPayProvider implements IPaymentProvider {
  readonly name: PaymentProviderName = "crystalpay";
  private readonly client: CrystalPayClient;

  constructor() {
    this.client = new CrystalPayClient(
      config.PAYMENT_CRYSTALPAY_ID,
      config.PAYMENT_CRYSTALPAY_SECRET_ONE
    );
  }

  async createInvoice(
    amount: number,
    orderId: string
  ): Promise<Invoice> {
    try {
      const invoice = await this.client.createInvoice(amount, orderId);

      return {
        id: invoice.id,
        url: invoice.url,
        amount,
        provider: this.name,
        status: InvoiceStatus.PENDING,
        expiresAt: (invoice as { expired_at?: string }).expired_at ? new Date((invoice as { expired_at?: string }).expired_at! + " UTC+3") : undefined,
      };
    } catch (error) {
      Logger.error("Failed to create CrystalPay invoice", error);
      throw new PaymentError("Failed to create CrystalPay invoice", "crystalpay");
    }
  }

  async checkStatus(invoiceId: string): Promise<InvoiceStatus> {
    try {
      const invoiceInfo = await this.client.getInvoice(invoiceId);

      switch (invoiceInfo.state) {
        case "payed":
          return InvoiceStatus.PAID;
        case "failed":
        case "unavailable":
          return InvoiceStatus.FAILED;
        default:
          // Check expiration
          if (invoiceInfo.expired_at) {
            const expiredAt = new Date(invoiceInfo.expired_at + " UTC+3");
            if (expiredAt < new Date()) {
              return InvoiceStatus.EXPIRED;
            }
          }
          return InvoiceStatus.PENDING;
      }
    } catch (error) {
      Logger.error("Failed to check CrystalPay invoice status", error);
      throw new PaymentError("Failed to check CrystalPay invoice status", "crystalpay");
    }
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    try {
      const invoiceInfo = await this.client.getInvoice(invoiceId);

      let status: InvoiceStatus;
      switch (invoiceInfo.state) {
        case "payed":
          status = InvoiceStatus.PAID;
          break;
        case "failed":
        case "unavailable":
          status = InvoiceStatus.FAILED;
          break;
        default:
          if (invoiceInfo.expired_at) {
            const expiredAt = new Date(invoiceInfo.expired_at + " UTC+3");
            if (expiredAt < new Date()) {
              status = InvoiceStatus.EXPIRED;
            } else {
              status = InvoiceStatus.PENDING;
            }
          } else {
            status = InvoiceStatus.PENDING;
          }
      }

      return {
        id: invoiceId,
        url: invoiceInfo.url || "",
        amount: Number(invoiceInfo.initial_amount || invoiceInfo.rub_amount || 0),
        provider: this.name,
        status,
        expiresAt: invoiceInfo.expired_at
          ? new Date(invoiceInfo.expired_at + " UTC+3")
          : undefined,
      };
    } catch (error) {
      Logger.error("Failed to get CrystalPay invoice", error);
      throw new PaymentError("Failed to get CrystalPay invoice", "crystalpay");
    }
  }
}
