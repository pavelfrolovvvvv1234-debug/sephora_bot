/**
 * Short-TTL in-memory cache for User by telegramId.
 * Reduces DB load on repeated updates from the same user.
 *
 * @module shared/user-cache
 */

import type User from "../entities/User.js";

const TTL_MS = 5 * 60 * 1000; // 5 минут — меньше обращений к БД, кнопки реагируют быстрее

interface Entry {
  user: User;
  expiresAt: number;
}

const cache = new Map<number, Entry>();

/**
 * Get cached user or null if missing/expired.
 */
export function getCachedUser(telegramId: number): User | null {
  const entry = cache.get(telegramId);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) cache.delete(telegramId);
    return null;
  }
  return entry.user;
}

/**
 * Store user in cache.
 */
export function setCachedUser(telegramId: number, user: User): void {
  cache.set(telegramId, {
    user,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Invalidate cache for a user (e.g. after balance/role update).
 */
export function invalidateUser(telegramId: number): void {
  cache.delete(telegramId);
}
