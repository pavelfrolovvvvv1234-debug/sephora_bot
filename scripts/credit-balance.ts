/**
 * One-off script: credit balance to a user by Telegram ID.
 * Usage: npx tsx scripts/credit-balance.ts <telegramId> <amount>
 * Example: npx tsx scripts/credit-balance.ts 75681777886 150
 */

import "dotenv/config";
import { getAppDataSource } from "../src/infrastructure/db/datasource.js";
import { UserRepository } from "../src/infrastructure/db/repositories/UserRepository.js";
import { BillingService } from "../src/domain/billing/BillingService.js";
import { TopUpRepository } from "../src/infrastructure/db/repositories/TopUpRepository.js";
import { closeDataSource } from "../src/infrastructure/db/datasource.js";

const telegramId = Number(process.argv[2]);
const amount = Number(process.argv[3]);

if (!telegramId || !Number.isFinite(telegramId) || !amount || !Number.isFinite(amount) || amount <= 0) {
  console.error("Usage: npx tsx scripts/credit-balance.ts <telegramId> <amount>");
  console.error("Example: npx tsx scripts/credit-balance.ts 75681777886 150");
  process.exit(1);
}

async function main() {
  const dataSource = await getAppDataSource();
  const userRepo = new UserRepository(dataSource);
  const topUpRepo = new TopUpRepository(dataSource);
  const billingService = new BillingService(dataSource, userRepo, topUpRepo);

  const user = await userRepo.findOrCreateByTelegramId(telegramId);
  await billingService.addBalance(user.id, amount);

  const updated = await userRepo.findById(user.id);
  console.log(`Done. User telegramId=${telegramId} (id=${user.id}): balance ${updated!.balance.toFixed(2)}$ (credited +${amount}$).`);
  await closeDataSource();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
