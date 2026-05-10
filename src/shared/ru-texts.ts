/**
 * Жёстко заданные русские тексты для приветствия и профиля.
 * Не используют Fluent/сессию — язык не может переключиться на EN.
 *
 * @module shared/ru-texts
 */

/** Русское приветствие (всегда). */
export function getWelcomeTextRu(balance: number): string {
  const b = Number.isFinite(balance) ? Math.round(balance) : 0;
  return `💚 SephoraHost — Самые Дешевые И Быстрые VPS на рынке

Добро пожаловать в бот.

<blockquote>Баланс: ${b} $</blockquote>`;
}

/** Футер профиля (RU) — HTML-ссылки. */
export const PROFILE_LINKS_RU =
  '<a href="https://t.me/sephora_sup">Support</a> | <a href="https://t.me/sephora_news">Sephora News</a>';
