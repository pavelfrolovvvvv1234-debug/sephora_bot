/**
 * Проверка конфигурации способов пополнения (CrystalPay и Crypto Pay).
 * Запуск: npx ts-node scripts/check-payments.ts
 * или: npm run check-payments
 */
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const crystalpayId = process.env["PAYMENT_CRYSTALPAY_ID"]?.trim();
const crystalpaySecret = process.env["PAYMENT_CRYSTALPAY_SECRET_ONE"]?.trim();
const cryptopayToken =
  process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
  process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();

function status(ok: boolean, label: string): string {
  return ok ? `✅ ${label}` : `❌ ${label}`;
}

async function checkCryptoPayToken(): Promise<{ ok: boolean; message: string }> {
  if (!cryptopayToken) {
    return { ok: false, message: "Токен не задан" };
  }
  try {
    const res = await fetch("https://pay.crypt.bot/api/getMe", {
      method: "GET",
      headers: { "Crypto-Pay-API-Token": cryptopayToken },
    });
    const data = (await res.json()) as {
      ok?: boolean;
      result?: { app_id?: number };
      error?: { name?: string };
    };
    if (data.ok && data.result?.app_id) {
      return { ok: true, message: `Токен валиден (app_id: ${data.result.app_id})` };
    }
    return { ok: false, message: data.error?.name || "Токен не прошёл проверку" };
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `Ошибка запроса: ${err}` };
  }
}

async function main(): Promise<void> {
  console.log("\n--- Проверка способов пополнения ---\n");

  const crystalpayConfigured = !!(crystalpayId && crystalpaySecret);
  console.log(status(crystalpayConfigured, "CrystalPay"));
  if (crystalpayConfigured) {
    console.log(`   PAYMENT_CRYSTALPAY_ID: ${crystalpayId?.slice(0, 8)}...`);
  } else {
    if (!crystalpayId) console.log("   Не задан PAYMENT_CRYSTALPAY_ID");
    if (!crystalpaySecret) console.log("   Не задан PAYMENT_CRYSTALPAY_SECRET_ONE");
  }

  console.log("");
  const cryptopayConfigured = !!cryptopayToken;
  console.log(status(cryptopayConfigured, "Crypto Pay (CryptoBot)"));
  if (cryptopayConfigured) {
    console.log(`   Токен: ${cryptopayToken.slice(0, 15)}...`);
    const check = await checkCryptoPayToken();
    if (check.ok) {
      console.log(`   ${check.message}`);
    } else {
      console.log(`   ⚠️  ${check.message}`);
    }
  } else {
    console.log("   Не задан PAYMENT_CRYPTOBOT_TOKEN и PAYMENT_CRYPTO_PAY_TOKEN");
  }

  console.log("\n--- Итог ---");
  if (crystalpayConfigured && cryptopayConfigured) {
    console.log("Оба способа пополнения настроены. Можно проверять в боте.\n");
  } else {
    console.log("Задайте недостающие переменные в .env и перезапустите бота.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
