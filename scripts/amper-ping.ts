/**
 * Быстрая проверка: доступен ли Amper API.
 * Запуск: npm run amper-ping
 * Выход: 0 = ворк, 1 = не ворк (с выводом причины).
 */
import "dotenv/config";
import axios from "axios";

const apiBaseUrl = (process.env.AMPER_API_BASE_URL || "https://amper.lat")
  .trim()
  .replace(/\/docs\/?$/, "")
  .replace(/\/api\/v1$/, "");
const apiToken = (process.env.AMPER_API_TOKEN || "").trim();
const auth = apiToken.startsWith("ApiKey ") ? apiToken : `ApiKey ${apiToken}`;

async function main() {
  if (!apiToken) {
    console.log("NOT WORK: AMPER_API_TOKEN не задан в .env");
    process.exit(1);
  }

  const client = axios.create({
    baseURL: apiBaseUrl,
    timeout: 10000,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
  });

  try {
    const res = await client.get("/api/v1/domains/check", {
      params: { domain: "example.com" },
    });
    if (res.status === 200 && typeof res.data === "object") {
      console.log("WORK: Amper API отвечает 200, проверка доступности ок.");
      process.exit(0);
    }
    console.log("NOT WORK: Неожиданный ответ:", res.status, res.data);
    process.exit(1);
  } catch (err: any) {
    const status = err.response?.status;
    const data = err.response?.data;
    if (status === 502 || status === 503 || status === 504) {
      console.log(`NOT WORK: Сервер Amper недоступен (${status}). Попробуй позже.`);
    } else if (status === 401) {
      console.log("NOT WORK: Неверный или просроченный AMPER_API_TOKEN.");
      console.log("Проверь .env: ключ скопирован целиком, без пробелов. Новый ключ — в кабинете Amper. Подробнее: scripts/AMPER_CHECK.md");
    } else if (status === 400 && data?.error?.code === "VALIDATION_ERROR") {
      console.log("WORK: API доступен (проверка вернула 400 по формату — это ожидаемо для их API).");
      process.exit(0);
    } else {
      console.log("NOT WORK:", status ? `HTTP ${status}` : err.message, data ? JSON.stringify(data).slice(0, 200) : "");
    }
    process.exit(1);
  }
}

main();
