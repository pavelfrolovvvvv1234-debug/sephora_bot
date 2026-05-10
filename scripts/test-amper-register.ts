/**
 * Тестовый скрипт для проверки регистрации домена через Amper API.
 * Запуск: npx tsx scripts/test-amper-register.ts <domain>
 * Пример: npx tsx scripts/test-amper-register.ts test123.com
 * Если Amper check возвращает 400 VALIDATION_ERROR — скрипт делает проверку через WHOIS.
 */
import "dotenv/config";
import axios from "axios";
import { checkAvailabilityWhois } from "../src/infrastructure/domains/whoisAvailability.js";

const domain = process.argv[2] || "test123.com";
const apiBaseUrl = (process.env.AMPER_API_BASE_URL || "").trim().replace(/\/docs\/?$/, "").replace(/\/api\/v1$/, "") || "https://amper.lat";
const apiToken = (process.env.AMPER_API_TOKEN || "").trim();
const auth = apiToken.startsWith("ApiKey ") ? apiToken : `ApiKey ${apiToken}`;

console.log("=== Тест регистрации домена через Amper API ===\n");
console.log("Domain:", domain);
console.log("Base URL:", apiBaseUrl);
console.log("Token (masked):", apiToken ? `${apiToken.slice(0, 12)}...` : "(empty)");
console.log("");

if (!apiToken) {
  console.error("❌ AMPER_API_TOKEN не установлен в .env");
  process.exit(1);
}

const client = axios.create({
  baseURL: apiBaseUrl,
  timeout: 8000,
  headers: {
    Authorization: auth,
    "Content-Type": "application/json",
  },
});

async function testCheck() {
  console.log("--- 1. Проверка доступности ---");
  
  // Пробуем разные форматы
  const formats = [
    { domain },
    { name: domain.split(".")[0], tld: domain.split(".").slice(1).join(".") },
  ];
  
  let lastStatus: number | undefined;
  for (const params of formats) {
    console.log(`\nПробуем формат:`, params);
    try {
      const response = await client.get("/api/v1/domains/check", { params });
      console.log("✅ Status:", response.status);
      console.log("Response:", JSON.stringify(response.data, null, 2));
      return { source: "amper", ...response.data };
    } catch (error: any) {
      lastStatus = error.response?.status;
      const code = error.response?.data?.error?.code;
      console.log("❌ Status:", lastStatus);
      console.log("Error:", JSON.stringify(error.response?.data, null, 2));
      if (lastStatus === 400 && code === "VALIDATION_ERROR") continue;
      return null;
    }
  }
  
  // Amper всегда вернул 400 VALIDATION_ERROR — проверяем через WHOIS (как в боте)
  if (lastStatus === 400) {
    console.log("\nAmper check возвращает VALIDATION_ERROR → проверка через WHOIS...");
    try {
      const whoisResult = await checkAvailabilityWhois(domain);
      console.log("WHOIS результат:", whoisResult.available ? "✅ Доступен" : "❌ Занят", whoisResult.reason || "");
      return { source: "whois", available: whoisResult.available, reason: whoisResult.reason };
    } catch (e: any) {
      console.log("WHOIS ошибка:", e?.message || e);
      return null;
    }
  }
  
  return null;
}

async function testRegister() {
  console.log("\n--- 2. Регистрация домена ---");
  const ns1 = process.env.DEFAULT_NS1 || "ns1.example.com";
  const ns2 = process.env.DEFAULT_NS2 || "ns2.example.com";
  const body = {
    domain,
    period: 1,
    nameservers: [ns1, ns2], // Amper ожидает массив, а не объект!
  };
  console.log("Request body:", JSON.stringify(body, null, 2));
  
  try {
    const response = await client.post("/api/v1/domains/register", body);
    console.log("✅ Status:", response.status);
    console.log("Response:", JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error: any) {
    console.log("❌ Status:", error.response?.status);
    console.log("Status Text:", error.response?.statusText);
    console.log("Error Data:", JSON.stringify(error.response?.data, null, 2));
    console.log("Error Message:", error.message);
    if (error.response?.data) {
      const errData = error.response.data;
      const apiError = errData?.error;
      console.log("\n--- Разбор ошибки ---");
      console.log("error.error:", apiError);
      console.log("error.message:", errData?.message);
      if (typeof apiError === "object") {
        console.log("error.error.message:", apiError?.message);
        console.log("error.error.code:", apiError?.code);
      }
    }
    return null;
  }
}

async function main() {
  const checkResult = await testCheck();
  console.log("\n");
  const registerResult = await testRegister();
  
  console.log("\n=== Итог ===");
  if (checkResult) {
    const src = checkResult.source === "whois" ? " (WHOIS)" : "";
    console.log("Проверка доступности: ✅ Успешно" + src);
    console.log("  available:", checkResult.available);
    if (checkResult.reason) console.log("  reason:", checkResult.reason);
  } else {
    console.log("Проверка доступности: ❌ Ошибка");
  }
  
  if (registerResult) {
    console.log("Регистрация: ✅ Успешно");
    console.log("  success:", registerResult.success);
    console.log("  domainId:", registerResult.domainId);
    console.log("  error:", registerResult.error);
  } else {
    console.log("Регистрация: ❌ Ошибка");
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
