/**
 * Проверка Amper API без пополнения кабинета.
 * Используются только check и getPrice — они не списывают деньги.
 *
 * Запуск: npx tsx scripts/test-amper-api.ts
 * Или: node --loader ts-node/esm scripts/test-amper-api.ts (если нужно)
 */
import "dotenv/config";
import { AmperDomainsProvider } from "../src/infrastructure/domains/AmperDomainsProvider.js";

const baseUrl = (process.env["AMPER_API_BASE_URL"] ?? "").trim();
const token = (process.env["AMPER_API_TOKEN"] ?? "").trim();
const timeoutMs = parseInt(process.env["AMPER_API_TIMEOUT_MS"] ?? "8000", 10);

function log(msg: string, data?: unknown) {
  console.log(msg);
  if (data !== undefined) console.log(data);
}

async function main() {
  console.log("--- Проверка Amper API ---\n");

  if (!baseUrl || !token) {
    console.log("❌ В .env задайте AMPER_API_BASE_URL и AMPER_API_TOKEN");
    process.exit(1);
  }

  const provider = new AmperDomainsProvider({
    apiBaseUrl: baseUrl,
    apiToken: token,
    timeoutMs,
  });

  // 1. Проверка доступности (бесплатно). Избегаем зарезервированных имён (example и т.д.).
  const testDomain = "sephorahost-check.com";
  log(`1. Проверка доступности: ${testDomain}`);
  try {
    const availability = await provider.checkAvailability(testDomain);
    log("   Результат:", {
      available: availability.available,
      reason: availability.reason ?? "(нет)",
    });
    console.log(availability.available ? "   ✅ Запрос к API прошёл.\n" : "   ✅ Запрос к API прошёл (домен занят/недоступен).\n");
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    console.log("   ❌ Ошибка:", err);
    console.log("   Проверьте AMPER_API_BASE_URL, AMPER_API_TOKEN и доступность amper.lat\n");
    process.exit(1);
  }

  // 2. Получение цены (бесплатно). При 400 от Amper провайдер возвращает заглушку { price: 0 }
  log("2. Получение цены: TLD .com, 1 год");
  try {
    const priceInfo = await provider.getPrice(".com", 1);
    log("   Результат:", { price: priceInfo.price, currency: priceInfo.currency ?? "USD" });
    if (priceInfo.price > 0) {
      console.log("   ✅ Цена получена, API отвечает.\n");
    } else {
      console.log("   ⚠️ API вернул 400 — использована заглушка (price=0). Уточните формат у Amper.\n");
    }
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    console.log("   ❌ Ошибка:", err);
    console.log("   Проверьте AMPER_API_BASE_URL и AMPER_API_TOKEN.\n");
  }

  console.log("--- Итог ---");
  console.log("Если оба шага прошли — API и токен работают.");
  console.log("Покупка (register) списывает деньги в кабинете Amper; при нулевом балансе там регистрация будет падать с ошибкой от Amper.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
