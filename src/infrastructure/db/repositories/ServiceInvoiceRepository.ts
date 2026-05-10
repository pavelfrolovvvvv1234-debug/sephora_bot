/**
 * Service invoice repository for service payments.
 *
 * @module infrastructure/db/repositories/ServiceInvoiceRepository
 */

import { DataSource } from "typeorm";
import ServiceInvoice, {
  ServiceInvoiceStatus,
} from "../../../entities/ServiceInvoice.js";
import { BaseRepository } from "./base.js";

export class ServiceInvoiceRepository extends BaseRepository<ServiceInvoice> {
  constructor(dataSource: DataSource) {
    super(dataSource, ServiceInvoice);
  }

  async findByInvoiceId(invoiceId: string): Promise<ServiceInvoice | null> {
    return this.repository.findOne({ where: { invoiceId } });
  }

  async findPending(): Promise<ServiceInvoice[]> {
    return this.repository.find({ where: { status: ServiceInvoiceStatus.Pending } });
  }
}
