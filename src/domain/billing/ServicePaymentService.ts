/**
 * Service payment service for Crypto Pay invoices.
 *
 * @module domain/billing/ServicePaymentService
 */

import { DataSource } from "typeorm";
import { CryptoBotProvider } from "../../infrastructure/payments/cryptobot.js";
import ServiceInvoice, {
  ServiceInvoiceStatus,
  ServiceType,
} from "../../entities/ServiceInvoice.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import DedicatedServer from "../../entities/DedicatedServer.js";
import { Logger } from "../../app/logger.js";
import { NotFoundError, BusinessError } from "../../shared/errors/index.js";

export interface CreateServiceInvoiceInput {
  userId: number;
  serviceType: ServiceType;
  serviceId: number;
  amount: number;
  description: string;
  chatId?: number;
  messageId?: number;
}

const buildPayload = (userId: number, serviceType: ServiceType, serviceId: number) =>
  `user_id:${userId}|service_id:${serviceType}:${serviceId}`;

export class ServicePaymentService {
  private readonly provider = new CryptoBotProvider();

  constructor(private dataSource: DataSource) {}

  async createServiceInvoice(input: CreateServiceInvoiceInput): Promise<ServiceInvoice> {
    if (input.amount <= 0) {
      throw new BusinessError("Invalid payment amount");
    }

    if (input.serviceType === "vds") {
      const vdsRepo = this.dataSource.getRepository(VirtualDedicatedServer);
      const vds = await vdsRepo.findOne({ where: { id: input.serviceId } });
      if (!vds) {
        throw new NotFoundError("VirtualDedicatedServer", input.serviceId);
      }
      if (vds.targetUserId !== input.userId) {
        throw new BusinessError("Service ownership mismatch");
      }
    }

    if (input.serviceType === "dedicated") {
      const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);
      const dedicated = await dedicatedRepo.findOne({ where: { id: input.serviceId } });
      if (!dedicated) {
        throw new NotFoundError("DedicatedServer", input.serviceId);
      }
      if (dedicated.userId !== input.userId) {
        throw new BusinessError("Service ownership mismatch");
      }
    }

    const payload = buildPayload(input.userId, input.serviceType, input.serviceId);
    const invoice = await this.provider.createInvoice(input.amount, payload, {
      payload,
      description: input.description,
      allow_comments: false,
      allow_anonymous: false,
    });

    const repo = this.dataSource.getRepository(ServiceInvoice);
    const serviceInvoice = new ServiceInvoice();
    serviceInvoice.invoiceId = invoice.id;
    serviceInvoice.provider = "cryptobot";
    serviceInvoice.userId = input.userId;
    serviceInvoice.serviceType = input.serviceType;
    serviceInvoice.serviceId = input.serviceId;
    serviceInvoice.amount = input.amount;
    serviceInvoice.status = ServiceInvoiceStatus.Pending;
    serviceInvoice.payload = payload;
    serviceInvoice.payUrl = invoice.url;
    serviceInvoice.chatId = input.chatId ?? null;
    serviceInvoice.messageId = input.messageId ?? null;

    return repo.save(serviceInvoice);
  }

  async attachMessage(
    invoiceId: string,
    chatId: number,
    messageId: number
  ): Promise<void> {
    const repo = this.dataSource.getRepository(ServiceInvoice);
    const invoice = await repo.findOne({ where: { invoiceId } });
    if (!invoice) {
      throw new NotFoundError("ServiceInvoice", invoiceId);
    }
    invoice.chatId = chatId;
    invoice.messageId = messageId;
    await repo.save(invoice);
  }

  async handlePaidInvoice(
    invoiceId: string,
    payload: string | null
  ): Promise<ServiceInvoice | null> {
    const repo = this.dataSource.getRepository(ServiceInvoice);
    const invoice = await repo.findOne({ where: { invoiceId } });
    if (!invoice) {
      Logger.warn(`ServiceInvoice ${invoiceId} not found`);
      return null;
    }

    if (invoice.status === ServiceInvoiceStatus.Paid) {
      return invoice;
    }

    if (payload && payload !== invoice.payload) {
      Logger.warn(`ServiceInvoice payload mismatch for ${invoiceId}`);
      return null;
    }

    invoice.status = ServiceInvoiceStatus.Paid;
    invoice.paidAt = new Date();
    await repo.save(invoice);

    await this.applyServicePayment(invoice);

    return invoice;
  }

  async getPaidUntil(
    invoice: ServiceInvoice
  ): Promise<Date | null> {
    if (invoice.serviceType === "vds") {
      const vdsRepo = this.dataSource.getRepository(VirtualDedicatedServer);
      const vds = await vdsRepo.findOne({ where: { id: invoice.serviceId } });
      return vds?.expireAt || null;
    }

    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);
    const dedicated = await dedicatedRepo.findOne({ where: { id: invoice.serviceId } });
    return dedicated?.paidUntil || null;
  }

  async markExpired(invoiceId: string): Promise<void> {
    const repo = this.dataSource.getRepository(ServiceInvoice);
    const invoice = await repo.findOne({ where: { invoiceId } });
    if (!invoice || invoice.status !== ServiceInvoiceStatus.Pending) {
      return;
    }
    invoice.status = ServiceInvoiceStatus.Expired;
    await repo.save(invoice);
  }

  private async applyServicePayment(invoice: ServiceInvoice): Promise<void> {
    if (invoice.serviceType === "vds") {
      const vdsRepo = this.dataSource.getRepository(VirtualDedicatedServer);
      const vds = await vdsRepo.findOne({ where: { id: invoice.serviceId } });
      if (!vds) {
        throw new NotFoundError("VirtualDedicatedServer", invoice.serviceId);
      }
      const base = vds.expireAt && vds.expireAt > new Date() ? vds.expireAt : new Date();
      vds.expireAt = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
      await vdsRepo.save(vds);
      return;
    }

    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);
    const dedicated = await dedicatedRepo.findOne({ where: { id: invoice.serviceId } });
    if (!dedicated) {
      throw new NotFoundError("DedicatedServer", invoice.serviceId);
    }
    const base =
      dedicated.paidUntil && dedicated.paidUntil > new Date()
        ? dedicated.paidUntil
        : new Date();
    dedicated.paidUntil = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
    await dedicatedRepo.save(dedicated);
  }
}
