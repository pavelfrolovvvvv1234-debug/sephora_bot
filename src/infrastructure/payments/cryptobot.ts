/**
 * CryptoBot payment provider implementation.
 *
 * @module infrastructure/payments/cryptobot
 */
import axios from "axios";
import { IPaymentProvider, Invoice, InvoiceStatus } from "./types";

const CRYPTOBOT_API_URL = "https://pay.crypt.bot/api";

type CryptoBotInvoice = {
  invoice_id: number;
  pay_url?: string;
  bot_invoice_url?: string;
  amount: string;
  status: "active" | "paid" | "expired" | "paid_over";
};

type CryptoBotResponse<T> = {
  ok: boolean;
  result?: T;
  error?: {
    name?: string;
    code?: number;
  };
};

function getCryptoBotToken(): string {
  const token =
    process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
    process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "PAYMENT_CRYPTOBOT_TOKEN or PAYMENT_CRYPTO_PAY_TOKEN is not set"
    );
  }
  return token;
}

function mapStatus(status: CryptoBotInvoice["status"]): InvoiceStatus {
  if (status === "paid" || status === "paid_over") {
    return InvoiceStatus.PAID;
  }
  if (status === "expired") {
    return InvoiceStatus.EXPIRED;
  }
  return InvoiceStatus.PENDING;
}

export class CryptoBotProvider implements IPaymentProvider {
  readonly name = "cryptobot";

  async createInvoice(
    amount: number,
    orderId: string,
    metadata?: Record<string, unknown>
  ): Promise<Invoice> {
    const token = getCryptoBotToken();
    const payload = (metadata?.payload as string | undefined) || orderId;
    const description = metadata?.description as string | undefined;
    const allowComments =
      typeof metadata?.allow_comments === "boolean"
        ? (metadata.allow_comments as boolean)
        : false;
    const allowAnonymous =
      typeof metadata?.allow_anonymous === "boolean"
        ? (metadata.allow_anonymous as boolean)
        : false;

    const response = await axios.post<CryptoBotResponse<CryptoBotInvoice>>(
      `${CRYPTOBOT_API_URL}/createInvoice`,
      {
        asset: "USDT",
        amount: amount.toString(),
        payload,
        description,
        allow_comments: allowComments,
        allow_anonymous: allowAnonymous,
      },
      {
        headers: {
          "Crypto-Pay-API-Token": token,
        },
      }
    );

    if (!response.data?.ok || !response.data.result) {
      const errorName = response.data?.error?.name || "CryptoBot invoice failed";
      throw new Error(errorName);
    }

    const invoice = response.data.result;
    const url = invoice.bot_invoice_url ?? invoice.pay_url ?? "";
    return {
      id: String(invoice.invoice_id),
      url,
      amount,
      provider: this.name,
      status: mapStatus(invoice.status),
    };
  }

  async checkStatus(invoiceId: string): Promise<InvoiceStatus> {
    const invoice = await this.getInvoice(invoiceId);
    return invoice.status;
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    const token = getCryptoBotToken();
    const response = await axios.post<
      CryptoBotResponse<{ items: CryptoBotInvoice[] }>
    >(
      `${CRYPTOBOT_API_URL}/getInvoices`,
      {
        invoice_ids: [Number(invoiceId)],
      },
      {
        headers: {
          "Crypto-Pay-API-Token": token,
        },
      }
    );

    if (!response.data?.ok || !response.data.result?.items?.length) {
      const errorName =
        response.data?.error?.name || "CryptoBot invoice not found";
      throw new Error(errorName);
    }

    const invoice = response.data.result.items[0];
    const url = invoice.bot_invoice_url ?? invoice.pay_url ?? "";
    return {
      id: String(invoice.invoice_id),
      url,
      amount: Number(invoice.amount),
      provider: this.name,
      status: mapStatus(invoice.status),
    };
  }
}
