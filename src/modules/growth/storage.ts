/**
 * TTL storage for growth offers (Redis or in-memory fallback).
 *
 * @module modules/growth/storage
 */

import { Logger } from "../../app/logger.js";

const DEFAULT_TTL_SEC = 30 * 60; // 30 min for upsell

let redisClient: import("ioredis").Redis | null = null;
let redisInit: Promise<import("ioredis").Redis | null> | null = null;

async function getRedis(): Promise<import("ioredis").Redis | null> {
  if (redisClient) return redisClient;
  const url = process.env["REDIS_URL"]?.trim();
  if (!url) return null;
  if (!redisInit) {
    redisInit = (async () => {
      try {
        const { default: Redis } = await import("ioredis");
        const client = new Redis(url, { maxRetriesPerRequest: 2 });
        client.on("error", (err: Error) => Logger.error("[Growth] Redis error", err));
        redisClient = client;
        return client;
      } catch (e) {
        Logger.warn("[Growth] Redis not available, using in-memory store", e);
        return null;
      }
    })();
  }
  return redisInit;
}

const memoryStore = new Map<string, { value: string; expiresAt: number }>();

function cleanupMemory(): void {
  const now = Date.now();
  for (const [k, v] of memoryStore.entries()) {
    if (v.expiresAt <= now) memoryStore.delete(k);
  }
}

export async function setOffer(
  key: string,
  value: string,
  ttlSec: number = DEFAULT_TTL_SEC
): Promise<void> {
  const redis = await getRedis();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  if (redis) {
    await redis.setex(key, ttlSec, value);
    return;
  }
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  setTimeout(cleanupMemory, 1000);
}

export async function getOffer(key: string): Promise<string | null> {
  const redis = await getRedis();
  if (redis) {
    const v = await redis.get(key);
    return v;
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

export async function deleteOffer(key: string): Promise<void> {
  const redis = await getRedis();
  if (redis) await redis.del(key);
  else memoryStore.delete(key);
}

export async function acquireLock(key: string, ttlSec: number): Promise<boolean> {
  const redis = await getRedis();
  if (redis) {
    const ok = await redis.set(key, "1", "EX", ttlSec, "NX");
    return ok === "OK";
  }
  if (memoryStore.has(key)) return false;
  memoryStore.set(key, { value: "1", expiresAt: Date.now() + ttlSec * 1000 });
  return true;
}

export async function isRedisAvailable(): Promise<boolean> {
  return (await getRedis()) !== null;
}
