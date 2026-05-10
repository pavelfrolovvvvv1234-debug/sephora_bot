import type { DataSource } from "typeorm";
import { Logger } from "../../app/logger.js";

const STATUS_MAP: Record<string, string> = {
  new: "open",
  in_provisioning: "in_progress",
  awaiting_final_check: "in_progress",
  pending_review: "in_progress",
  paid: "waiting",
  awaiting_payment: "waiting",
  awaiting_stock: "waiting",
  completed: "done",
  rejected: "done",
  cancelled: "done",
};

export async function runProvisioningStatusMigration(
  dataSource: DataSource
): Promise<void> {
  let changed = 0;
  for (const [from, to] of Object.entries(STATUS_MAP)) {
    const result = await dataSource
      .createQueryBuilder()
      .update("provisioning_tickets")
      .set({ status: to })
      .where("status = :from", { from })
      .execute();
    changed += Number(result.affected ?? 0);
  }

  if (changed > 0) {
    Logger.info(
      `Provisioning status migration applied: ${changed} ticket records updated`
    );
  }
}
