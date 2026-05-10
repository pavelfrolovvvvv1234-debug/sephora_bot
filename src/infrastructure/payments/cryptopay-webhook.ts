/**
 * Crypto Pay webhook handler utilities.
 *
 * @module infrastructure/payments/cryptopay-webhook
 */

import { createHmac } from "crypto";
import type { Request, Response } from "express";
import { getAppDataSource } from "../db/datasource.js";
import { ServicePaymentService } from "../../domain/billing/ServicePaymentService.js";
import { Logger } from "../../app/logger.js";
import type { Bot, Api, RawApi } from "grammy";

const getCryptoPayToken = (): string => {
  const token =
    process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
    process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "PAYMENT_CRYPTOBOT_TOKEN or PAYMENT_CRYPTO_PAY_TOKEN is not set"
    );
  }
  return token;
};

const getSignatureHeader = (req: Request): string | undefined => {
  const header =
    (req.headers["crypto-pay-api-signature"] as string | undefined) ||
    (req.headers["crypto-pay-api-signature".toLowerCase()] as string | undefined);
  return header;
};

const verifySignature = (rawBody: string, signature?: string): boolean => {
  if (!signature) {
    return false;
  }
  const token = getCryptoPayToken();
  const expected = createHmac("sha256", token).update(rawBody).digest("hex");
  return expected === signature;
};

const parseInvoicePayload = (body: any): { invoiceId?: string; status?: string; payload?: string } => {
  const data = body?.payload ?? body?.invoice ?? body;
  const invoiceId =
    data?.invoice_id ?? data?.invoiceId ?? body?.invoice_id ?? body?.invoiceId;
  const status = data?.status ?? body?.status;
  const payload = data?.payload ?? body?.payload;
  return {
    invoiceId: invoiceId ? String(invoiceId) : undefined,
    status,
    payload,
  };
};

const buildPaidMessage = (paidUntil: Date | null): string => {
  const dateText = paidUntil
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(paidUntil)
    : "N/A";
  return `✅ Paid\nPaid until: ${dateText}`;
};

export const handleCryptoPayWebhook = async (
  req: Request,
  res: Response,
  bot: Bot<any, Api<RawApi>>
): Promise<void> => {
  try {
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body || {});
    const signature = getSignatureHeader(req);
    if (!verifySignature(rawBody, signature)) {
      res.status(401).send("invalid signature");
      return;
    }

    const { invoiceId, status, payload } = parseInvoicePayload(req.body);
    if (!invoiceId) {
      res.status(400).send("missing invoice_id");
      return;
    }

    if (status !== "paid" && status !== "paid_over" && req.body?.update_type !== "invoice_paid") {
      res.status(200).send("ignored");
      return;
    }

    const dataSource = await getAppDataSource();
    const service = new ServicePaymentService(dataSource);
    const invoice = await service.handlePaidInvoice(invoiceId, payload || null);
    if (!invoice) {
      res.status(200).send("ok");
      return;
    }

    const paidUntil = await service.getPaidUntil(invoice);
    if (invoice.chatId && invoice.messageId) {
      await bot.api.editMessageText(
        invoice.chatId,
        invoice.messageId,
        buildPaidMessage(paidUntil)
      );
    }

    res.status(200).send("ok");
  } catch (error) {
    Logger.error("Crypto Pay webhook error", error);
    res.status(500).send("error");
  }
};
