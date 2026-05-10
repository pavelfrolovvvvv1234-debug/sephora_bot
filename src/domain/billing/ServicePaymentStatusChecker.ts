/**
 * Background checker for service invoices (Crypto Pay).
 *
 * @module domain/billing/ServicePaymentStatusChecker
 */

import { CryptoBotProvider } from "../../infrastructure/payments/cryptobot.js";
import { ServiceInvoiceRepository } from "../../infrastructure/db/repositories/ServiceInvoiceRepository.js";
import { InvoiceStatus } from "../../infrastructure/payments/types.js";
import { Logger } from "../../app/logger.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import { ServicePaymentService } from "./ServicePaymentService.js";
import type { Bot, Api, RawApi } from "grammy";

export class ServicePaymentStatusChecker {
  private intervalId?: NodeJS.Timeout;
  private readonly provider = new CryptoBotProvider();
  private readonly checkIntervalMs = 15_000;

  constructor(private bot?: Bot<any, Api<RawApi>>) {}

  start(): void {
    if (this.intervalId) {
      return;
    }
    this.intervalId = setInterval(() => {
      this.check().catch((error) => {
        Logger.error("ServicePaymentStatusChecker error", error);
      });
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async check(): Promise<void> {
    const dataSource = await getAppDataSource();
    const repo = new ServiceInvoiceRepository(dataSource);
    const service = new ServicePaymentService(dataSource);

    const pending = await repo.findPending();
    if (pending.length === 0) {
      return;
    }

    for (const invoice of pending) {
      try {
        const info = await this.provider.getInvoice(invoice.invoiceId);
        if (info.status === InvoiceStatus.PAID) {
          const updated = await service.handlePaidInvoice(invoice.invoiceId, invoice.payload);
          if (updated && this.bot && updated.chatId && updated.messageId) {
            const paidUntil = await service.getPaidUntil(updated);
            const dateText = paidUntil
              ? new Intl.DateTimeFormat("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(paidUntil)
              : "N/A";
            await this.bot.api.editMessageText(
              updated.chatId,
              updated.messageId,
              `✅ Paid\nPaid until: ${dateText}`
            );
          }
        } else if (info.status === InvoiceStatus.EXPIRED) {
          await service.markExpired(invoice.invoiceId);
        }
      } catch (error) {
        Logger.warn(`Failed to check service invoice ${invoice.invoiceId}`, error);
      }
    }
  }
}
