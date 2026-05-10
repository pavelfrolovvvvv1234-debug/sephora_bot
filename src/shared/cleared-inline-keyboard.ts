import { InlineKeyboard } from "grammy";

/** Drop every inline button. `new InlineKeyboard()` defaults to `[[]]`, which is not equivalent. */
export function clearedInlineKeyboard(): InlineKeyboard {
  return new InlineKeyboard([]);
}
