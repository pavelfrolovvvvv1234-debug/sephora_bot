/**
 * Screen types for unified screen rendering.
 *
 * @module ui/screens/types
 */

import type { InlineKeyboard } from "grammy";

/**
 * Screen data for rendering.
 */
export interface ScreenData {
  [key: string]: unknown;
}

/**
 * Rendered screen result.
 */
export interface RenderedScreen {
  text: string;
  keyboard?: InlineKeyboard;
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
}

/**
 * Screen renderer function type.
 */
export type ScreenRendererFn = (
  data: ScreenData,
  locale: string
) => RenderedScreen | Promise<RenderedScreen>;
