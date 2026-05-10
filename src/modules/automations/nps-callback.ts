/**
 * NPS (1–5) callback: parse payload and return reply messages for promoter/detractor.
 *
 * @module modules/automations/nps-callback
 */

export const NPS_CALLBACK_PREFIX = "nps:";

export function parseNpsPayload(
  callbackData: string
): { rating: number; branch: "promoter" | "detractor" | "neutral" } | null {
  if (!callbackData.startsWith(NPS_CALLBACK_PREFIX)) return null;
  const rating = parseInt(callbackData.slice(NPS_CALLBACK_PREFIX.length), 10);
  if (Number.isNaN(rating) || rating < 1 || rating > 5) return null;
  const branch = rating >= 4 ? "promoter" : rating <= 2 ? "detractor" : "neutral";
  return { rating, branch };
}

export function getNpsReplyMessage(
  branch: "promoter" | "detractor" | "neutral",
  lang: "ru" | "en"
): string {
  const ru: Record<string, string> = {
    promoter:
      "Спасибо за высокую оценку! 🎉 Приглашайте друзей по реферальной ссылке — получайте % с их пополнений. Или воспользуйтесь скидкой на годовое продление в профиле.",
    detractor:
      "Жаль, что что-то не понравилось. Напишите в поддержку — мы разберёмся и поможем. Кнопка «Задать вопрос» в меню откроет чат с нами.",
    neutral:
      "Спасибо за отзыв. Если появится идея, как нам стать лучше — напишите в поддержку. Мы всегда на связи.",
  };
  const en: Record<string, string> = {
    promoter:
      "Thanks for the high rating! 🎉 Invite friends via your referral link — earn % from their deposits. Or use the yearly renewal discount in your profile.",
    detractor:
      "Sorry something wasn't right. Contact support — we'll look into it and help. The «Ask question» button in the menu opens a chat with us.",
    neutral:
      "Thanks for your feedback. If you have ideas on how we can improve — contact support. We're here for you.",
  };
  const t = lang === "ru" ? ru : en;
  return t[branch] ?? t.neutral;
}
