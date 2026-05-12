/**
 * Users who must not receive broadcast-style messages from Sephora bot:
 * admin broadcasts, growth/campaign pushes, automation scenario sends, segment sends.
 *
 * Resolved by @username via getChat at startup (bot must have seen the user, or use env IDs).
 */

import type { Bot } from "grammy";

/** Lowercase Telegram usernames (without @). */
const HARDCODED_OPT_OUT_USERNAMES = [
  "utztpbsokclfb47w8qu1",
  "adeno",
  "sup_lzt",
  "hellosoulja",
  "adrenalain777",
] as const;

function parseEnvOptOutTelegramIds(): Set<number> {
  const raw = (process.env.BROADCAST_OPT_OUT_TELEGRAM_IDS ?? "").trim();
  const out = new Set<number>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (!Number.isNaN(n)) out.add(n);
  }
  return out;
}

const envOptOutIds = parseEnvOptOutTelegramIds();

const usernameResolvedIds = new Set<number>();

let warmPromise: Promise<void> | null = null;

/**
 * Resolve @usernames to numeric chat ids once. Safe to call multiple times.
 * Call early after bot is constructed.
 */
export function warmBroadcastOptOutTelegramIds(bot: Pick<Bot, "api">): Promise<void> {
  if (!warmPromise) {
    warmPromise = (async () => {
      for (const un of HARDCODED_OPT_OUT_USERNAMES) {
        try {
          const chat = (await bot.api.getChat(`@${un}`)) as { id?: number };
          if (typeof chat?.id === "number") usernameResolvedIds.add(chat.id);
        } catch {
          // User never interacted with bot — add BROADCAST_OPT_OUT_TELEGRAM_IDS with numeric id
        }
      }
    })();
  }
  return warmPromise;
}

export function isTelegramOptedOutOfSephoraBroadcasts(telegramId: number): boolean {
  if (envOptOutIds.has(telegramId)) return true;
  return usernameResolvedIds.has(telegramId);
}
