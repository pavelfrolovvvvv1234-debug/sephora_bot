/**
 * Heleket payment provider implementation.
 *
 * @module infrastructure/payments/heleket
 */
import axios from "axios";
import { createHash } from "crypto";
import { IPaymentProvider, Invoice, InvoiceStatus } from "./types";

type HeleketPayment = {
  uuid?: string;
  order_id?: string;
  amount?: string;
  url?: string;
  payment_status?: string;
  status?: string;
  expired_at?: number;
};

type HeleketResponse<T> = {
  state?: number;
  result?: T;
  error_message?: string;
  message?: string;
};

function getConfig(): { merchant: string; apiKey: string; baseUrl: string } {
  const merchant = process.env["PAYMENT_HELEKET_MERCHANT"]?.trim();
  const apiKey = process.env["PAYMENT_HELEKET_API_KEY"]?.trim();
  const baseUrl = process.env["PAYMENT_HELEKET_API_URL"]?.trim() || "https://api.heleket.com";
  if (!merchant || !apiKey) {
    throw new Error("PAYMENT_HELEKET_MERCHANT and PAYMENT_HELEKET_API_KEY are required");
  }
  return { merchant, apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

function sign(body: string, apiKey: string): string {
  return createHash("md5").update(Buffer.from(body).toString("base64") + apiKey).digest("hex");
}

function mapStatus(raw: string): InvoiceStatus {
  const s = raw.trim().toLowerCase();
  if (s === "paid" || s === "paid_over") return InvoiceStatus.PAID;
  if (
    s === "cancel" ||
    s === "fail" ||
    s === "wrong_amount" ||
    s === "system_fail" ||
    s === "refund_process" ||
    s === "refund_fail" ||
    s === "refund_paid"
  ) {
    return InvoiceStatus.FAILED;
  }
  return InvoiceStatus.PENDING;
}

export class HeleketProvider implements IPaymentProvider {
  readonly name = "heleket";

  async createInvoice(amount: number, orderId: string): Promise<Invoice> {
    const { merchant, apiKey, baseUrl } = getConfig();
    const payload = {
      amount: amount.toFixed(2),
      currency: "USD",
      order_id: orderId,
    };
    const body = JSON.stringify(payload);
    const response = await axios.post<HeleketResponse<HeleketPayment>>(
      `${baseUrl}/v1/payment`,
      payload,
      {
        headers: {
          merchant,
          sign: sign(body, apiKey),
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      }
    );

    const result = response.data?.result;
    const url = String(result?.url || "").trim();
    if (!url) {
      throw new Error(response.data?.error_message || response.data?.message || "Heleket invoice failed");
    }

    return {
      id: String(result?.order_id || orderId),
      url,
      amount,
      provider: this.name,
      status: mapStatus(String(result?.payment_status || result?.status || "pending")),
    };
  }

  async checkStatus(invoiceId: string): Promise<InvoiceStatus> {
    const invoice = await this.getInvoice(invoiceId);
    return invoice.status;
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    const { merchant, apiKey, baseUrl } = getConfig();
    const payload = { order_id: invoiceId };
    const body = JSON.stringify(payload);

    const response = await axios.post<HeleketResponse<HeleketPayment>>(
      `${baseUrl}/v1/payment/info`,
      payload,
      {
        headers: {
          merchant,
          sign: sign(body, apiKey),
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      }
    );

    const result = response.data?.result;
    if (!result) {
      throw new Error(response.data?.error_message || response.data?.message || "Heleket invoice not found");
    }
    const statusRaw = String(result.payment_status || result.status || "pending");
    const expiresAt = result.expired_at
      ? new Date(Number(result.expired_at) * 1000)
      : undefined;

    return {
      id: String(result.order_id || invoiceId),
      url: String(result.url || ""),
      amount: Number(result.amount || 0),
      provider: this.name,
      status: mapStatus(statusRaw),
      expiresAt,
    };
  }
}
