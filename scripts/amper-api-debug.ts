/**
 * Отладка Amper API: печать запроса и ответа.
 * Запуск: npx tsx scripts/amper-api-debug.ts
 */
import "dotenv/config";
import axios from "axios";

const baseUrl = (process.env["AMPER_API_BASE_URL"] ?? "").trim().replace(/\/docs\/?$/, "").replace(/\/api\/v1$/, "") || "https://amper.lat";
const token = (process.env["AMPER_API_TOKEN"] ?? "").trim();
const auth = token.startsWith("ApiKey ") ? token : `ApiKey ${token}`;

console.log("Base URL:", baseUrl);
console.log("Token (masked):", token ? `${token.slice(0, 12)}...` : "(empty)");
console.log("");

async function main() {
  const client = axios.create({
    baseURL: baseUrl,
    timeout: 8000,
    headers: { Authorization: auth, "Content-Type": "application/json" },
  });

  // Вариант: может быть нужен другой формат авторизации?
  const clientAlt = axios.create({
    baseURL: baseUrl,
    timeout: 8000,
    headers: { "X-API-Key": token, "Content-Type": "application/json" },
  });

  console.log("--- Вариант авторизации: X-API-Key вместо Authorization ---");
  try {
    const r0 = await clientAlt.get("/api/v1/domains/check", { params: { domain: "test.com" } });
    console.log("Status:", r0.status);
    console.log("Data:", JSON.stringify(r0.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  console.log("");

  // 1. GET check?domain=test.lat (Amper = amper.lat, возможно приоритет .lat)
  console.log("--- GET /api/v1/domains/check?domain=test.lat ---");
  try {
    const r1 = await client.get("/api/v1/domains/check", { params: { domain: "test.lat" } });
    console.log("Status:", r1.status);
    console.log("Data:", JSON.stringify(r1.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  console.log("");
  console.log("--- GET /api/v1/domains/check?domain=example.com ---");
  try {
    const r2 = await client.get("/api/v1/domains/check", { params: { domain: "example.com" } });
    console.log("Status:", r2.status);
    console.log("Data:", JSON.stringify(r2.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  console.log("");
  console.log("--- GET /api/v1/domains/price?domain=test.lat&period=1 ---");
  try {
    const r2b = await client.get("/api/v1/domains/price", { params: { domain: "test.lat", period: 1 } });
    console.log("Status:", r2b.status);
    console.log("Data:", JSON.stringify(r2b.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  console.log("");
  console.log("--- GET /api/v1/domains/price?tld=com&period=1 ---");
  try {
    const r3 = await client.get("/api/v1/domains/price", { params: { tld: "com", period: 1 } });
    console.log("Status:", r3.status);
    console.log("Data:", JSON.stringify(r3.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  console.log("");
  console.log("--- GET /api/v1/domains/price?domain=example.com&period=1 ---");
  try {
    const r4 = await client.get("/api/v1/domains/price", { params: { domain: "example.com", period: 1 } });
    console.log("Status:", r4.status);
    console.log("Data:", JSON.stringify(r4.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  // Вариант: check с доменом в path (некоторые API так делают)
  console.log("");
  console.log("--- GET /api/v1/domains/check/example.com ---");
  try {
    const r5 = await client.get("/api/v1/domains/check/example.com");
    console.log("Status:", r5.status);
    console.log("Data:", JSON.stringify(r5.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  // Вариант: может быть нужен query параметр name вместо domain?
  console.log("");
  console.log("--- GET /api/v1/domains/check?name=example.com ---");
  try {
    const r6 = await client.get("/api/v1/domains/check", { params: { name: "example.com" } });
    console.log("Status:", r6.status);
    console.log("Data:", JSON.stringify(r6.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", JSON.stringify(e.response?.data, null, 2));
  }

  // Вариант: может быть нужен другой путь? /v1/domains/availability?
  console.log("");
  console.log("--- GET /api/v1/domains/availability?domain=example.com ---");
  try {
    const r7 = await client.get("/api/v1/domains/availability", { params: { domain: "example.com" } });
    console.log("Status:", r7.status);
    console.log("Data:", JSON.stringify(r7.data, null, 2));
  } catch (e: any) {
    console.log("Status:", e.response?.status);
    console.log("Data:", e.response?.status === 404 ? "404 Not Found" : JSON.stringify(e.response?.data, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
